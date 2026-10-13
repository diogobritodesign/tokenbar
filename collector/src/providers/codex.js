import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME } from '../paths.js';
import { isDirectory } from '../files.js';
import { CollectError, fetchJson } from '../http.js';
import { t } from '../i18n.js';

const CODEX_DIR = path.join(HOME, '.codex');
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const hint = () => t('codex.hint');
const SESSION_MAX_SECONDS = 6 * 60 * 60;

// Somente leitura: o auth.json do Codex nunca é alterado nem renovado aqui.
async function readAuth() {
  let auth;
  try {
    auth = JSON.parse(await fs.readFile(path.join(CODEX_DIR, 'auth.json'), 'utf8'));
  } catch {
    throw new CollectError('unauthorized', t('codex.noCredentials', { hint: hint() }));
  }
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) throw new CollectError('unauthorized', t('codex.noChatgptLogin', { hint: hint() }));
  return { accessToken: String(accessToken), accountId: auth.tokens.account_id ? String(auth.tokens.account_id) : '' };
}

function toIso(ms) {
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export function toWindow(raw, now) {
  const used = Number(raw?.used_percent);
  if (!raw || !Number.isFinite(used)) return null;
  const seconds = Number(raw.limit_window_seconds);
  const session = Number.isFinite(seconds) && seconds <= SESSION_MAX_SECONDS;
  // O reset vem como instante (epoch em segundos) ou como "daqui a N segundos".
  const resetAt = Number(raw.reset_at);
  const resetAfter = Number(raw.reset_after_seconds);
  const resetMs = Number.isFinite(resetAt) && resetAt > 0
    ? resetAt * 1000
    : Number.isFinite(resetAfter) && resetAfter > 0
      ? now + resetAfter * 1000
      : null;
  return {
    kind: session ? 'session' : 'weekly',
    label: session ? '5h' : t('label.week'),
    windowMinutes: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : session ? 300 : 10080,
    usedPct: Math.round(Math.min(Math.max(used, 0), 100)),
    resetsAt: resetMs ? toIso(resetMs) : null
  };
}

function planLabel(planType) {
  const plan = String(planType || '').trim();
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

async function fetchLimits() {
  const auth = await readAuth();
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${auth.accessToken}`,
    'user-agent': 'tokenbar/0.1'
  };
  if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;

  let usage;
  try {
    usage = await fetchJson(USAGE_URL, headers);
  } catch (error) {
    if (error instanceof CollectError && error.status === 'unauthorized') {
      error.message = t('codex.invalidLogin', { hint: hint() });
    }
    throw error;
  }
  const limit = usage?.rate_limit;
  const now = Date.now();
  const windows = [toWindow(limit?.primary_window, now), toWindow(limit?.secondary_window, now)].filter(Boolean);
  if (windows.length === 0) throw new CollectError('error', t('codex.noLimits'));
  return { plan: planLabel(usage?.plan_type), windows };
}

export const codexProviders = [
  {
    id: 'codex',
    label: 'OAI',
    name: 'Codex / ChatGPT',
    exists: () => isDirectory(CODEX_DIR),
    fetchLimits,
    // Só limites por enquanto; os tokens das sessões locais não são somados.
    usageToday: async () => null
  }
];
