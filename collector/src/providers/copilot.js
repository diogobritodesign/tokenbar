import { home } from '../paths.js';
import { platform } from '../platform/index.js';
import { join } from '../util/path.js';
import { isDirectory } from '../files.js';
import { CollectError, NETWORK_TIMEOUT_MS } from '../http.js';
import { t } from '../i18n.js';

const copilotDir = () => join(home(), '.copilot');

// A cota é lida pela CLI oficial do GitHub (`gh api`), que usa o login que ela
// mesma guarda no chaveiro. O coletor nunca vê o token.
const QUOTAS = [
  ['chat', () => 'Chat'],
  ['completions', () => t('label.code')],
  ['premium_interactions', () => 'Premium']
];

async function runGh(args) {
  const result = await platform.exec(['gh', ...args], NETWORK_TIMEOUT_MS);
  if (result.ok) return result.stdout;
  if (result.notFound) throw new CollectError('error', t('copilot.noGh'));
  if (result.timedOut) throw new CollectError('error', t('net.timeout'));
  const text = result.stderr;
  if (/HTTP 401|HTTP 403|not logged|authentication|gh auth login/i.test(text)) {
    throw new CollectError('unauthorized', t('copilot.noLogin', { hint: t('copilot.hint') }));
  }
  if (/HTTP 404/.test(text)) throw new CollectError('error', t('copilot.noCopilot'));
  if (/HTTP 429/.test(text)) throw new CollectError('rate_limited', t('net.rateLimited'));
  throw new CollectError('error', t('copilot.ghFailed'));
}

function resetIso(data) {
  const at = Date.parse(data?.quota_reset_date_utc || data?.quota_reset_date || '');
  return Number.isFinite(at) ? new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

export function mapWindows(data) {
  const resetsAt = resetIso(data);
  const windows = [];
  for (const [key, label] of QUOTAS) {
    const quota = data?.quota_snapshots?.[key];
    const remaining = Number(quota?.percent_remaining);
    // Cota ilimitada ou sem franquia (ex.: premium no plano gratuito) não vira medidor.
    if (!quota || quota.unlimited === true || !(Number(quota.entitlement) > 0) || !Number.isFinite(remaining)) continue;
    windows.push({
      kind: 'monthly',
      label: label(),
      usedPct: Math.round(Math.min(Math.max(100 - remaining, 0), 100)),
      resetsAt
    });
  }
  return windows;
}

export function planLabel(data) {
  const sku = String(data?.access_type_sku || '');
  if (sku.includes('free')) return 'Free';
  const plan = String(data?.copilot_plan || '').trim();
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

async function fetchLimits() {
  let data;
  try {
    data = JSON.parse(await runGh(['api', 'copilot_internal/user']));
  } catch (error) {
    if (error instanceof CollectError) throw error;
    throw new CollectError('error', t('copilot.badResponse'));
  }
  const windows = mapWindows(data);
  if (windows.length === 0) throw new CollectError('error', t('copilot.noQuota'));
  return { plan: planLabel(data), windows };
}

export const copilotProviders = [
  {
    id: 'copilot',
    label: 'GH',
    name: 'GitHub Copilot',
    exists: () => isDirectory(copilotDir()),
    // Cota mensal: uma consulta a cada 10 min basta e poupa o limite da API do GitHub.
    minIntervalMs: 10 * 60 * 1000,
    fetchLimits,
    usageToday: async () => null
  }
];
