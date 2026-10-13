import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { HOME } from '../paths.js';
import { isDirectory } from '../files.js';
import { CollectError, NETWORK_TIMEOUT_MS } from '../http.js';
import { t } from '../i18n.js';

// As cotas são lidas do language server que o próprio Antigravity mantém
// rodando: ele escuta em 127.0.0.1 e aceita chamadas com o token CSRF que
// recebeu na linha de comando. Nenhuma credencial do Google é lida ou renovada.
const DATA_DIRS = ['antigravity', 'antigravity-ide', 'antigravity-cli'].map((name) => path.join(HOME, '.gemini', name));
const RPC_SERVICE = 'exa.language_server_pb.LanguageServerService';
const RPC_TIMEOUT_MS = 3000;
const STATUS_METADATA = { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' };

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index !== -1) return argv[index + 1] || '';
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : '';
}

async function findLanguageServers() {
  let entries;
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return [];
  }
  const servers = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let argv;
    try {
      argv = (await fs.readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0');
    } catch {
      continue;
    }
    if (!path.basename(argv[0] || '').startsWith('language_server')) continue;
    if (!argv.some((arg) => arg.toLowerCase().includes('antigravity'))) continue;
    const csrfToken = flagValue(argv, '--csrf_token');
    if (csrfToken) servers.push({ pid: Number(entry), csrfToken });
  }
  return servers;
}

function listeningSockets() {
  return new Promise((resolve) => {
    execFile('ss', ['-H', '-ltnp'], { timeout: RPC_TIMEOUT_MS }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

function portsOf(pid, sockets) {
  const ports = [];
  for (const line of sockets.split('\n')) {
    if (!line.includes(`pid=${pid},`)) continue;
    const match = /:(\d+)\s+\S+\s+users:/.exec(line);
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

function callRpc({ scheme, port, csrfToken }, method, body, signal) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = (scheme === 'https' ? https : http).request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/${RPC_SERVICE}/${method}`,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': csrfToken
        },
        timeout: RPC_TIMEOUT_MS,
        signal,
        // Certificado autoassinado do language server; a conexão nunca sai do loopback.
        rejectUnauthorized: false
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('rpc'));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('rpc'));
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('rpc')));
    request.on('error', reject);
    request.end(payload);
  });
}

function groupName(displayName) {
  const lower = String(displayName || '').toLowerCase();
  if (lower.includes('gemini')) return 'Gemini';
  if (lower.includes('claude') || lower.includes('gpt')) return 'Claude/GPT';
  return String(displayName || 'Cota').trim();
}

export function mapWindows(summary) {
  const groups = (summary?.response ?? summary)?.groups;
  const windows = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const name = groupName(group?.displayName);
    const inGroup = [];
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const kind = bucket?.window === '5h' ? 'session' : bucket?.window === 'weekly' ? 'weekly' : null;
      const remaining = Number(bucket?.remainingFraction);
      if (!kind || bucket?.disabled === true || !Number.isFinite(remaining)) continue;
      const resetsAt = Date.parse(bucket.resetTime);
      inGroup.push({
        kind,
        group: name,
        label: kind === 'session' ? '5h' : t('label.week'),
        windowMinutes: kind === 'session' ? 5 * 60 : 7 * 24 * 60,
        usedPct: Math.round(Math.min(Math.max(1 - remaining, 0), 1) * 100),
        resetsAt: Number.isFinite(resetsAt) ? new Date(Math.round(resetsAt / 1000) * 1000).toISOString().replace('.000Z', 'Z') : null
      });
    }
    // Dentro de cada grupo, 5h antes de semanal.
    inGroup.sort((a, b) => (a.kind === 'session' ? 0 : 1) - (b.kind === 'session' ? 0 : 1));
    windows.push(...inGroup);
  }
  return windows;
}

export function planFrom(status) {
  const tier = String(status?.userStatus?.userTier?.name || '').replace(/^Google\s+AI\s+/i, '').trim();
  return tier || String(status?.userStatus?.planStatus?.planInfo?.planName || '').trim() || null;
}

async function fetchLimits() {
  const servers = await findLanguageServers();
  if (servers.length === 0) {
    throw new CollectError('idle', t('antigravity.closed'));
  }
  const signal = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  const sockets = await listeningSockets();

  for (const server of servers) {
    for (const port of portsOf(server.pid, sockets)) {
      for (const scheme of ['https', 'http']) {
        const endpoint = { scheme, port, csrfToken: server.csrfToken };
        let windows;
        try {
          windows = mapWindows(await callRpc(endpoint, 'RetrieveUserQuotaSummary', { forceRefresh: true }, signal));
        } catch {
          if (signal.aborted) throw new CollectError('error', t('net.timeout'));
          continue;
        }
        if (windows.length === 0) continue;
        let plan = null;
        try {
          plan = planFrom(await callRpc(endpoint, 'GetUserStatus', { metadata: STATUS_METADATA }, signal));
        } catch {
          // O plano é só um rótulo; as cotas já vieram.
        }
        return { plan, windows };
      }
    }
  }
  throw new CollectError('error', t('antigravity.noQuota'));
}

async function anyDataDir() {
  for (const dir of DATA_DIRS) {
    if (await isDirectory(dir)) return true;
  }
  return false;
}

export const antigravityProviders = [
  {
    id: 'antigravity',
    label: 'AG',
    name: 'Antigravity',
    exists: anyDataDir,
    fetchLimits,
    // As conversas ficam em bancos protobuf próprios; não há contagem de
    // tokens legível sem uma ferramenta externa.
    usageToday: async () => null
  }
];
