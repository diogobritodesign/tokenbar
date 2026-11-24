import { home, stateDir } from '../paths.js';
import { platform } from '../platform/index.js';
import { join } from '../util/path.js';
import { isDirectory, readJson, writeJsonAtomic } from '../files.js';
import { CollectError, fetchJson } from '../http.js';
import { t } from '../i18n.js';
import { claudeDailyHistory, claudeUsageToday } from '../usage/claudeTranscripts.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
// Conta dona de cada token, consultada uma vez por token (só em memória, nunca gravada).
const tokenOwners = new Map();
const hint = () => t('claude.hint');

// A conta padrão fica em ~/.claude. Contas extras são pastas ~/.claude-<nome>
// ou ~/.claude_<nome> (as usadas com CLAUDE_CONFIG_DIR), mais as pastas que o
// usuário listar em `claudeDirs` no config.json. Cada pasta recebe um número
// fixo (claude-2/CLD2, claude-3/CLD3...) guardado em account-ids.json: uma
// pasta nova pega o próximo número livre e nunca muda o id das que já
// existem, então nomes e ordem escolhidos continuam na conta certa. Sem o
// arquivo, a numeração segue a ordem alfabética (a mesma das versões antigas).
const PREFIXES = ['.claude-', '.claude_'];

async function looksLikeAccount(dir) {
  if (!(await isDirectory(dir))) return false;
  // Só conta como conta se tiver login ou conversas; ~/.claude-backup e afins ficam de fora.
  return (await platform.exists(join(dir, '.credentials.json'))) || isDirectory(join(dir, 'projects'));
}

function tildePath(dir, homeDir) {
  return dir === homeDir ? '~' : dir.startsWith(`${homeDir}/`) ? `~${dir.slice(homeDir.length)}` : dir;
}

function expandHome(dir, homeDir) {
  const text = String(dir || '').trim();
  if (text === '~') return homeDir;
  if (text.startsWith('~/')) return join(homeDir, text.slice(2));
  return text.startsWith('/') ? text.replace(/\/+$/, '') : null;
}

const accountIdsFile = () => join(stateDir(), 'account-ids.json');

// Dá a cada pasta um número >= 2. `known` ({pasta: número}) é atualizado no
// lugar; números de pastas que sumiram não são reaproveitados.
export function assignAccountNumbers(dirs, known) {
  const used = new Set(Object.values(known).filter(Number.isInteger));
  let next = 2;
  let changed = false;
  for (const dir of dirs) {
    if (Number.isInteger(known[dir]) && known[dir] >= 2) continue;
    while (used.has(next)) next += 1;
    known[dir] = next;
    used.add(next);
    changed = true;
  }
  return changed;
}

async function loadKnownIds() {
  const saved = await readJson(accountIdsFile());
  const claude = saved?.claude;
  return claude && typeof claude === 'object' && !Array.isArray(claude) ? { ...claude } : {};
}

// `known` permite aos testes passar a numeração; sem ele, usa o arquivo.
export async function discoverClaudeAccounts(homeDir = home(), extraDirs = [], known = null) {
  const mainDir = join(homeDir, '.claude');
  // Sem acesso à pasta pessoal, a lista vem vazia e fica só a conta padrão.
  const names = (await platform.readdir(homeDir))
    .filter((name) => PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length))
    .sort();
  const dirs = [];
  for (const name of names) {
    const dir = join(homeDir, name);
    if (await looksLikeAccount(dir)) dirs.push(dir);
  }
  for (const raw of Array.isArray(extraDirs) ? extraDirs : []) {
    const dir = expandHome(raw, homeDir);
    if (dir && dir !== mainDir && !dirs.includes(dir) && (await looksLikeAccount(dir))) dirs.push(dir);
  }

  const persist = known === null;
  const numbers = persist ? await loadKnownIds() : known;
  if (assignAccountNumbers(dirs, numbers) && persist) {
    await writeJsonAtomic(accountIdsFile(), { version: 1, claude: numbers }).catch(() => {});
  }

  const extras = dirs
    .map((dir) => ({ dir, number: numbers[dir] }))
    .sort((a, b) => a.number - b.number);
  const multi = extras.length > 0;
  return [
    // A conta padrão guarda os dados da conta em ~/.claude.json; as outras, dentro da pasta.
    { id: 'claude-main', label: 'CLD', name: multi ? 'Claude 1' : 'Claude', source: tildePath(mainDir, homeDir), dir: mainDir, configFile: join(homeDir, '.claude.json') },
    ...extras.map(({ dir, number }) => ({
      id: `claude-${number}`,
      label: `CLD${number}`,
      name: `Claude ${number}`,
      source: tildePath(dir, homeDir),
      dir,
      configFile: join(dir, '.claude.json')
    }))
  ];
}

// Janelas extras por modelo que a API devolve além de five_hour/seven_day.
const SCOPED_WEEKLY = [
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet']
];

export function planLabel(oauth) {
  const type = String(oauth.subscriptionType || '').trim();
  if (!type) return null;
  const base = type.charAt(0).toUpperCase() + type.slice(1);
  const multiplier = /max_(\d+x)/i.exec(String(oauth.rateLimitTier || ''));
  return multiplier ? `${base} ${multiplier[1]}` : base;
}

// Somente leitura: o arquivo de credenciais nunca é alterado e o token
// expirado não é renovado aqui (isso é trabalho do próprio Claude Code).
async function readOauth(dir) {
  let parsed;
  try {
    parsed = JSON.parse(await platform.readText(join(dir, '.credentials.json')));
  } catch {
    throw new CollectError('unauthorized', t('claude.noCredentials', { hint: hint() }));
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken) throw new CollectError('unauthorized', t('claude.noCredentials', { hint: hint() }));
  return oauth;
}

function toWindow(kind, label, raw) {
  const windowMinutes = kind === 'session' ? 5 * 60 : 7 * 24 * 60;
  const used = Number(raw?.utilization);
  if (!raw || !Number.isFinite(used)) return null;
  const resetsAt = Date.parse(raw.resets_at);
  return {
    kind,
    label,
    windowMinutes,
    usedPct: Math.round(Math.min(Math.max(used, 0), 100)),
    resetsAt: Number.isFinite(resetsAt) ? new Date(Math.round(resetsAt / 1000) * 1000).toISOString().replace('.000Z', 'Z') : null
  };
}

export function mapWindows(usage) {
  const windows = [
    toWindow('session', '5h', usage?.five_hour),
    toWindow('weekly', t('label.week'), usage?.seven_day),
    ...SCOPED_WEEKLY.map(([key, label]) => toWindow('weekly-model', label, usage?.[key]))
  ];
  return windows.filter(Boolean);
}

function claudeProvider(account) {
  return {
    id: account.id,
    label: account.label,
    name: account.name,
    source: account.source,
    exists: () => isDirectory(account.dir),

    async fetchLimits() {
      const oauth = await readOauth(account.dir);
      const plan = planLabel(oauth);
      if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now()) {
        throw Object.assign(new CollectError('unauthorized', t('claude.expired', { hint: hint() })), { plan });
      }
      let usage;
      try {
        usage = await fetchJson(USAGE_URL, {
          accept: 'application/json',
          authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': 'tokenbar/0.1'
        });
      } catch (error) {
        if (error instanceof CollectError && error.status === 'unauthorized') {
          error.message = t('claude.refused', { hint: hint() });
        }
        throw Object.assign(error, { plan });
      }
      return { plan, windows: mapWindows(usage) };
    },

    // Para achar duas pastas logadas na mesma conta: `account` é o dono do
    // token (perfil da API) e `expected` a conta que o Claude Code registrou
    // na pasta. Diferentes = alguém fez /login com outra conta ali.
    async identity() {
      let oauth;
      try {
        oauth = await readOauth(account.dir);
      } catch {
        return null;
      }
      // Token vencido: nenhuma requisição (o Claude Code renova quando abrir).
      if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now()) return null;
      let owner = tokenOwners.get(oauth.accessToken);
      if (owner === undefined) {
        try {
          const profile = await fetchJson(PROFILE_URL, {
            accept: 'application/json',
            authorization: `Bearer ${oauth.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'user-agent': 'tokenbar/0.1'
          });
          owner = profile?.account?.uuid ? String(profile.account.uuid) : null;
        } catch {
          return null;
        }
        if (tokenOwners.size > 32) tokenOwners.clear();
        tokenOwners.set(oauth.accessToken, owner);
      }
      if (!owner) return null;
      let expected = null;
      try {
        expected = JSON.parse(await platform.readText(account.configFile))?.oauthAccount?.accountUuid ?? null;
      } catch {
        expected = null;
      }
      return { account: owner, expected: expected ? String(expected) : null };
    },

    usageToday: (usageCache, now) => claudeUsageToday(join(account.dir, 'projects'), usageCache, now),
    dailyHistory: (sinceMs) => claudeDailyHistory(join(account.dir, 'projects'), sinceMs)
  };
}

export async function claudeProviders(extraDirs = []) {
  return (await discoverClaudeAccounts(home(), extraDirs)).map(claudeProvider);
}
