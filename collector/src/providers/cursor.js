import { home } from '../paths.js';
import { platform } from '../platform/index.js';
import { join } from '../util/path.js';
import { isDirectory } from '../files.js';
import { CollectError, fetchJson, NETWORK_TIMEOUT_MS } from '../http.js';
import { t } from '../i18n.js';

const USAGE_URL = 'https://cursor.com/api/usage-summary';
const hint = () => t('cursor.hint');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

// Credenciais em dois lugares distintos (podem ser contas diferentes):
//   IDE  — SQLite em ~/.config/Cursor/.../state.vscdb (e ~/.config/Cursor-<nome>)
//   CLI  — JSON em ~/.config/cursor/auth.json
const configHome = () => platform.env().XDG_CONFIG_HOME || join(home(), '.config');

function stateDbPath(cursorDir) {
  return join(cursorDir, 'User', 'globalStorage', 'state.vscdb');
}

function base64UrlToUtf8(segment) {
  const b64 = String(segment).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function workosUserId(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2) return null;
  try {
    const subject = JSON.parse(base64UrlToUtf8(parts[1]))?.sub;
    if (typeof subject !== 'string' || !subject) return null;
    const userId = subject.includes('|') ? subject.slice(subject.lastIndexOf('|') + 1) : subject;
    return userId.startsWith('user_') ? userId : null;
  } catch {
    return null;
  }
}

export function sessionCookie(accessToken) {
  const userId = workosUserId(accessToken);
  if (!userId) return null;
  return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
}

export function planLabel(membershipType) {
  const plan = String(membershipType || '').trim();
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

export function mapWindows(usage) {
  const startMs = Date.parse(usage?.billingCycleStart || usage?.billing_cycle_start || '');
  const endMs = Date.parse(usage?.billingCycleEnd || usage?.billing_cycle_end || '');
  const windowMinutes = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.round((endMs - startMs) / 60_000)
    : null;
  // Ciclo de ~7 dias = semanal; o resto trata como mensalidade do plano.
  const weekly = windowMinutes !== null && windowMinutes <= 8 * 24 * 60;
  const resetsAt = Number.isFinite(endMs)
    ? new Date(Math.round(endMs / 1000) * 1000).toISOString().replace('.000Z', 'Z')
    : null;
  const window = (usedPct) => ({
    kind: weekly ? 'weekly' : 'monthly',
    label: weekly ? t('label.week') : t('label.plan'),
    windowMinutes: windowMinutes ?? (weekly ? 10080 : 30 * 24 * 60),
    usedPct,
    resetsAt
  });

  if (usage?.isUnlimited === true) return [window(0)];

  const plan = usage?.individualUsage?.plan ?? usage?.individual_usage?.plan ?? usage?.planUsage;
  if (!plan || plan.enabled === false) return [];
  const used = Number(plan.totalPercentUsed ?? plan.total_percent_used);
  if (!Number.isFinite(used)) return [];
  return [window(Math.round(Math.min(Math.max(used, 0), 100)))];
}

async function readCliAuth(path) {
  let parsed;
  try {
    parsed = JSON.parse(await platform.readText(path));
  } catch {
    return null;
  }
  const accessToken = String(parsed?.accessToken || parsed?.access_token || '').trim();
  if (!accessToken) return null;
  return {
    accessToken,
    email: parsed.email || parsed.cachedEmail || null,
    membershipType: parsed.membershipType || parsed.stripeMembershipType || null
  };
}

// Lê as chaves de autenticação do state.vscdb sem gravar nada. Preferimos
// python3 (já comum no desktop Linux; a bandeja do TokenBar também o usa).
async function readIdeAuth(dbPath) {
  if (!(await platform.exists(dbPath))) return null;
  const script = [
    'import json,sqlite3,sys',
    'db=sys.argv[1]',
    'con=sqlite3.connect("file:%s?mode=ro"%db,uri=True)',
    'out={}',
    'for k in ("cursorAuth/accessToken","cursorAuth/cachedEmail","cursorAuth/stripeMembershipType"):',
    ' r=con.execute("SELECT value FROM ItemTable WHERE key=?",(k,)).fetchone()',
    ' if r and r[0] is not None:',
    '  v=r[0].decode() if isinstance(r[0],(bytes,bytearray)) else str(r[0])',
    '  out[k.split("/",1)[1]]=v',
    'print(json.dumps(out))'
  ].join('\n');
  const result = await platform.exec(['python3', '-c', script, dbPath], NETWORK_TIMEOUT_MS);
  if (result.notFound) throw new CollectError('error', t('cursor.noPython'));
  if (!result.ok) return null;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const accessToken = String(parsed?.accessToken || '').trim();
  if (!accessToken) return null;
  return {
    accessToken,
    email: parsed.cachedEmail || null,
    membershipType: parsed.stripeMembershipType || null
  };
}

async function listIdeDirs(configDir) {
  const names = (await platform.readdir(configDir))
    .filter((name) => name === 'Cursor' || name.startsWith('Cursor-'))
    .sort((a, b) => (a === 'Cursor' ? 0 : 1) - (b === 'Cursor' ? 0 : 1) || a.localeCompare(b));
  const dirs = [];
  for (const name of names) {
    const dir = join(configDir, name);
    if (!(await isDirectory(dir))) continue;
    if (!(await platform.exists(stateDbPath(dir)))) continue;
    dirs.push({ dir, suffix: name === 'Cursor' ? null : name.slice('Cursor-'.length) });
  }
  return dirs;
}

export async function discoverCursorAccounts(configDir = configHome()) {
  const found = [];

  let ideReader = readIdeAuth;
  for (const ide of await listIdeDirs(configDir)) {
    let auth;
    try {
      auth = await ideReader(stateDbPath(ide.dir));
    } catch (error) {
      // Sem python3 não lemos o IDE; a CLI (auth.json) ainda pode aparecer.
      if (error instanceof CollectError) {
        ideReader = async () => null;
        continue;
      }
      auth = null;
    }
    if (!auth) continue;
    const userId = workosUserId(auth.accessToken);
    found.push({
      source: 'ide',
      id: ide.suffix ? `cursor-ide-${ide.suffix}` : 'cursor-ide',
      suffix: ide.suffix,
      userId,
      email: auth.email,
      membershipType: auth.membershipType,
      readAuth: async () => readIdeAuth(stateDbPath(ide.dir))
    });
  }

  const cliPath = join(configDir, 'cursor', 'auth.json');
  if (await platform.exists(cliPath)) {
    const auth = await readCliAuth(cliPath);
    if (auth) {
      const userId = workosUserId(auth.accessToken);
      // Mesma conta no IDE e na CLI: fica só a do IDE (tem e-mail e plano locais).
      if (!userId || !found.some((entry) => entry.userId === userId)) {
        found.push({
          source: 'cli',
          id: 'cursor-cli',
          suffix: null,
          userId,
          email: auth.email,
          membershipType: auth.membershipType,
          readAuth: async () => readCliAuth(cliPath)
        });
      }
    }
  }

  // Nomes sem e-mail nem id: o state.json nunca deve carregar dado pessoal.
  const multi = found.length > 1;
  return found.map((entry, index) => {
    const label = index === 0 ? 'CUR' : `CUR${index + 1}`;
    let name = 'Cursor';
    if (multi) {
      if (entry.source === 'cli') name = t('name.cursorCli');
      else if (entry.suffix) name = `Cursor (${entry.suffix})`;
      else name = t('name.cursorIde');
    }
    return {
      id: entry.id,
      label,
      name,
      source: entry.source,
      readAuth: entry.readAuth
    };
  });
}

function cursorProvider(account) {
  return {
    id: account.id,
    label: account.label,
    name: account.name,
    // A conta "existe" se ainda conseguimos achar as credenciais dela.
    exists: async () => Boolean(await account.readAuth().catch(() => null)),
    // Cotas do ciclo de cobrança: a cada 5 min basta.
    minIntervalMs: 5 * 60 * 1000,

    async fetchLimits() {
      const auth = await account.readAuth();
      if (!auth?.accessToken) {
        throw new CollectError('unauthorized', t('cursor.noCredentials', { hint: hint() }));
      }
      const cookie = sessionCookie(auth.accessToken);
      if (!cookie) {
        throw new CollectError('unauthorized', t('cursor.badToken', { hint: hint() }));
      }
      const localPlan = planLabel(auth.membershipType);
      let usage;
      try {
        usage = await fetchJson(USAGE_URL, {
          accept: 'application/json',
          cookie,
          'user-agent': USER_AGENT
        });
      } catch (error) {
        if (error instanceof CollectError && error.status === 'unauthorized') {
          error.message = t('cursor.refused', { hint: hint() });
        }
        throw Object.assign(error, { plan: localPlan });
      }
      const plan = planLabel(usage?.membershipType) || localPlan;
      const windows = mapWindows(usage);
      if (windows.length === 0) {
        throw Object.assign(new CollectError('error', t('cursor.noLimits')), { plan });
      }
      return { plan, windows };
    },

    usageToday: async () => null
  };
}

export async function cursorProviders() {
  return (await discoverCursorAccounts()).map(cursorProvider);
}
