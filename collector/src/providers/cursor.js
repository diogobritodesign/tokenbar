import { home } from '../paths.js';
import { platform } from '../platform/index.js';
import { join } from '../util/path.js';
import { isDirectory } from '../files.js';
import { CollectError, fetchJson, NETWORK_TIMEOUT_MS } from '../http.js';
import { t } from '../i18n.js';

// Painel novo (Premium / pool semanal): DashboardService com o token do IDE.
// usage-summary do site ainda devolve o ciclo mensal antigo (muitas vezes 0%).
const PERIOD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const SUMMARY_URL = 'https://cursor.com/api/usage-summary';
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

// ISO ou epoch em ms (às vezes string), como no DashboardService.
export function cycleMs(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) {
    const number = Number(trimmed);
    return number > 1e11 ? number : number * 1000;
  }
  return Date.parse(trimmed);
}

// Unifica a resposta do DashboardService com a do usage-summary.
export function normalizeCursorUsage(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.planUsage && !raw.individualUsage) {
    return {
      billingCycleStart: raw.billingCycleStart,
      billingCycleEnd: raw.billingCycleEnd,
      membershipType: raw.membershipType,
      isUnlimited: raw.isUnlimited,
      individualUsage: { plan: raw.planUsage, onDemand: raw.onDemand }
    };
  }
  return raw;
}

export function mapWindows(usage) {
  const startMs = cycleMs(usage?.billingCycleStart || usage?.billing_cycle_start);
  const endMs = cycleMs(usage?.billingCycleEnd || usage?.billing_cycle_end);
  const windowMinutes = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.round((endMs - startMs) / 60_000)
    : null;
  // Ciclo de ~7 dias = semanal (pool do Premium); o resto é mensal.
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

  const windows = [];
  if (usage?.isUnlimited === true) {
    windows.push(window(0));
  } else {
    const plan = usage?.individualUsage?.plan ?? usage?.individual_usage?.plan ?? usage?.planUsage;
    if (plan && plan.enabled !== false) {
      const used = Number(plan.totalPercentUsed ?? plan.total_percent_used);
      if (Number.isFinite(used)) windows.push(window(Math.round(Math.min(Math.max(used, 0), 100))));
    }
  }

  // Franquia on-demand (pago à parte), quando o painel do Cursor informa teto.
  const onDemand = usage?.individualUsage?.onDemand ?? usage?.individual_usage?.on_demand;
  if (onDemand?.enabled === true) {
    const used = Number(onDemand.used);
    const limit = Number(onDemand.limit);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      windows.push({
        kind: weekly ? 'weekly' : 'monthly',
        label: t('label.onDemand'),
        windowMinutes: windowMinutes ?? (weekly ? 10080 : 30 * 24 * 60),
        usedPct: Math.round(Math.min(Math.max((used / limit) * 100, 0), 100)),
        resetsAt
      });
    }
  }
  return windows;
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

  for (const ide of await listIdeDirs(configDir)) {
    let auth;
    try {
      auth = await readIdeAuth(stateDbPath(ide.dir));
    } catch (error) {
      // Sem python3: ainda listamos a conta do IDE para o cartão explicar o erro.
      if (error instanceof CollectError) {
        found.push({
          source: 'ide',
          id: ide.suffix ? `cursor-ide-${ide.suffix}` : 'cursor-ide',
          suffix: ide.suffix,
          userId: null,
          readAuth: async () => {
            throw error;
          },
          fetchError: error
        });
        break;
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
      readAuth: async () => readIdeAuth(stateDbPath(ide.dir))
    });
  }
  const cliPath = join(configDir, 'cursor', 'auth.json');
  if (await platform.exists(cliPath)) {
    const auth = await readCliAuth(cliPath);
    if (auth) {
      const userId = workosUserId(auth.accessToken);
      // Mesma conta no IDE e na CLI: fica só a do IDE.
      if (!userId || !found.some((entry) => entry.userId && entry.userId === userId)) {
        found.push({
          source: 'cli',
          id: 'cursor-cli',
          suffix: null,
          userId,
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
      readAuth: entry.readAuth,
      fetchError: entry.fetchError || null
    };
  });
}

function cursorProvider(account) {
  return {
    id: account.id,
    label: account.label,
    name: account.name,
    // A conta "existe" se ainda há pasta/arquivo dela, mesmo sem conseguir ler.
    exists: async () => {
      if (account.fetchError) return true;
      return Boolean(await account.readAuth().catch(() => null));
    },
    // Cotas do ciclo de cobrança: a cada 5 min basta.
    minIntervalMs: 5 * 60 * 1000,

    async fetchLimits() {
      if (account.fetchError) throw account.fetchError;
      const auth = await account.readAuth();
      if (!auth?.accessToken) {
        throw new CollectError('unauthorized', t('cursor.noCredentials', { hint: hint() }));
      }
      const localPlan = planLabel(auth.membershipType);
      let usage = null;
      let lastError = null;

      // 1) Pool semanal do app (o mesmo número do painel Plan & Usage).
      try {
        usage = normalizeCursorUsage(await fetchJson(PERIOD_URL, {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${auth.accessToken}`,
          'user-agent': 'tokenbar/0.1'
        }, { method: 'POST', body: '{}' }));
      } catch (error) {
        lastError = error;
      }

      // 2) Fallback: usage-summary do site (ciclo mensal legado).
      if (!usage || mapWindows(usage).length === 0) {
        const cookie = sessionCookie(auth.accessToken);
        if (cookie) {
          try {
            usage = normalizeCursorUsage(await fetchJson(SUMMARY_URL, {
              accept: 'application/json',
              cookie,
              'user-agent': USER_AGENT
            }));
          } catch (error) {
            lastError = error;
          }
        }
      }

      if (!usage) {
        if (lastError instanceof CollectError && lastError.status === 'unauthorized') {
          lastError.message = t('cursor.refused', { hint: hint() });
        }
        throw Object.assign(lastError || new CollectError('error', t('cursor.noLimits')), { plan: localPlan });
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
