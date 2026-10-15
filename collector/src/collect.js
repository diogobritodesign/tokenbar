import { readJson, writeJsonAtomic } from './files.js';
import { usdBrlRate } from './fx.js';
import { BACKFILL_DAYS, loadHistory, recordDay, saveHistory, summarize } from './history.js';
import { CollectError, RATE_LIMIT_BACKOFF_MS } from './http.js';
import { LANGUAGES, setLanguage, t } from './i18n.js';
import { configFile, stateFile, usageCacheFile } from './paths.js';
import { antigravityProviders } from './providers/antigravity.js';
import { applyRecentPace } from './pace.js';
import { claudeProviders } from './providers/claude.js';
import { codexProviders } from './providers/codex.js';
import { copilotProviders } from './providers/copilot.js';
import { cursorProviders } from './providers/cursor.js';
import { serviceStatus } from './status.js';
import { checkForUpdate } from './update.js';
import { localDayKey } from './usage/claudeTranscripts.js';

const STATE_VERSION = 1;
const USAGE_CACHE_VERSION = 3;
const DEFAULT_INTERVAL_SEC = 120;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 3600;

// Todos os provedores cuja pasta existe nesta máquina, na ordem de exibição.
// A lista é descoberta a cada ciclo (contas Claude extras, perfis Cursor…):
// não há teto fixo — o que existir e estiver ligado nas configurações aparece.
async function listProviders() {
  const all = [
    ...(await claudeProviders()),
    ...codexProviders,
    ...(await cursorProviders()),
    ...antigravityProviders,
    ...copilotProviders
  ];
  const present = [];
  for (const provider of all) {
    if (await provider.exists()) present.push(provider);
  }
  return present;
}

// Só registra quando a mensagem de um provedor muda, para o journal não
// receber a mesma linha a cada ciclo.
const lastLogged = new Map();
function logError(scope, message) {
  if (lastLogged.get(scope) === message) return;
  lastLogged.set(scope, message);
  console.error(`tokenbar: ${scope}: ${message}`);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), min), max) : fallback;
}

export async function loadConfig() {
  const raw = (await readJson(configFile())) || {};
  const interval = Number(raw.intervalSec);
  return {
    intervalSec: Number.isFinite(interval)
      ? Math.min(Math.max(Math.round(interval), MIN_INTERVAL_SEC), MAX_INTERVAL_SEC)
      : DEFAULT_INTERVAL_SEC,
    disabledProviders: Array.isArray(raw.disabledProviders) ? raw.disabledProviders.map(String) : [],
    // null = seguir o idioma do sistema
    language: LANGUAGES.includes(raw.language) ? raw.language : null,
    // Checagem diária de versão nova no GitHub; ligada por padrão.
    updateCheck: raw.updateCheck !== false,
    // Opções de exibição para a bandeja e as barras fora do GNOME (no GNOME,
    // a extensão tem as próprias, no GSettings).
    bar: {
      showRemaining: raw.bar?.showRemaining !== false,
      warn: clampInt(raw.bar?.warn, 1, 99, 60),
      crit: clampInt(raw.bar?.crit, 2, 100, 85),
      currency: ['brl', 'usd'].includes(raw.bar?.currency) ? raw.bar.currency : null,
      label: ['critical', 'all', 'none'].includes(raw.bar?.label) ? raw.bar.label : 'critical'
    }
  };
}

async function loadUsageCache(now) {
  const day = localDayKey(now);
  const cache = await readJson(usageCacheFile());
  if (cache?.version === USAGE_CACHE_VERSION && cache.day === day && cache.files && typeof cache.files === 'object') {
    return cache;
  }
  return { version: USAGE_CACHE_VERSION, day, files: {} };
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function collectProvider(provider, previous, usageCache, now) {
  const result = {
    id: provider.id,
    label: provider.label,
    name: provider.name,
    plan: previous?.plan ?? null,
    status: 'ok',
    // Em caso de falha fica o último valor conhecido; a interface o mostra em cinza.
    windows: Array.isArray(previous?.windows) ? previous.windows : [],
    tokensToday: null,
    costTodayUsd: null,
    costPartial: false,
    tokensBreakdown: null,
    modelsToday: [],
    sessionsToday: [],
    error: null
  };

  try {
    const usage = await provider.usageToday(usageCache, now);
    result.tokensToday = usage?.tokens ?? null;
    result.costTodayUsd = usage?.costUsd ?? null;
    result.costPartial = (usage?.unpricedTokens ?? 0) > 0;
    result.tokensBreakdown = usage?.breakdown ?? null;
    result.modelsToday = usage?.models ?? [];
    result.sessionsToday = usage?.sessions ?? [];
  } catch {
    logError(provider.id, t('log.usageRead'));
  }

  // Cotas que mudam devagar (ex.: mensais) não precisam de consulta a cada ciclo.
  const checkedAt = Date.parse(previous?.checkedAt);
  if (
    provider.minIntervalMs &&
    previous?.status === 'ok' &&
    Number.isFinite(checkedAt) &&
    now.getTime() - checkedAt < provider.minIntervalMs
  ) {
    result.checkedAt = previous.checkedAt;
    return result;
  }

  const backoffUntil = Date.parse(previous?.rateLimitedUntil);
  if (Number.isFinite(backoffUntil) && backoffUntil > now.getTime()) {
    result.status = 'rate_limited';
    result.error = previous.error;
    result.rateLimitedUntil = previous.rateLimitedUntil;
    return result;
  }

  try {
    const limits = await provider.fetchLimits();
    result.plan = limits.plan ?? result.plan;
    result.windows = limits.windows;
    result.checkedAt = isoSeconds(now.getTime());
    lastLogged.delete(provider.id);
  } catch (error) {
    const known = error instanceof CollectError;
    result.status = known ? error.status : 'error';
    result.error = known ? error.message : t('unexpected');
    if (error?.plan) result.plan = error.plan;
    if (result.status === 'rate_limited') {
      result.rateLimitedUntil = isoSeconds(now.getTime() + (error.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS));
    }
    if (result.status === 'idle') {
      // Ferramenta fechada não é erro: fica o último valor, e uma janela cujo
      // reset já passou volta a zero.
      result.windows = result.windows.map((window) =>
        Date.parse(window?.resetsAt) <= now.getTime() ? { ...window, usedPct: 0, resetsAt: null } : window
      );
    } else {
      logError(provider.id, result.error);
    }
  }
  return result;
}

export async function collectOnce(config, { forceUpdateCheck = false } = {}) {
  setLanguage(config.language);
  const now = new Date();
  const previousState = await readJson(stateFile());
  const previousById = new Map(
    (Array.isArray(previousState?.providers) ? previousState.providers : []).map((entry) => [entry?.id, entry])
  );
  const usageCache = await loadUsageCache(now);

  const present = await listProviders();
  const active = present.filter((provider) => !config.disabledProviders.includes(provider.id));

  const [providers, fx, services, update] = await Promise.all([
    Promise.all(active.map((provider) => collectProvider(provider, previousById.get(provider.id), usageCache, now))),
    usdBrlRate(now.getTime()).catch(() => null),
    serviceStatus(now.getTime()).catch(() => []),
    checkForUpdate({ enabled: config.updateCheck, force: forceUpdateCheck, now: now.getTime() }).catch(() => null)
  ]);

  await applyRecentPace(providers, now.getTime());

  const history = await loadHistory();
  const today = localDayKey(now);
  for (const provider of providers) {
    if (provider.tokensToday !== null) {
      recordDay(history, today, provider.id, { tokens: provider.tokensToday, costUsd: provider.costTodayUsd });
    }
  }
  await saveHistory(history, now).catch(() => logError('history', t('log.historyWrite')));

  await writeJsonAtomic(stateFile(), {
    version: STATE_VERSION,
    updatedAt: isoSeconds(Date.now()),
    fx,
    services,
    update,
    // Todas as contas encontradas, inclusive as desligadas, para a tela de configurações.
    accounts: present.map(({ id, label, name }) => ({ id, label, name, enabled: !config.disabledProviders.includes(id) })),
    usage: summarize(history, now),
    providers
  });
  await writeJsonAtomic(usageCacheFile(), usageCache).catch(() => logError('cache', t('log.cacheWrite')));
}

// Semeia o histórico com os últimos dias lendo os transcripts inteiros. Roda
// uma vez só (no serviço, não no --once), porque é uma leitura pesada.
export async function backfillHistoryOnce(config) {
  if ((await loadHistory()).backfilledAt) return;
  const now = new Date();
  const today = localDayKey(now);
  const sinceMs = now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const collected = [];
  for (const provider of await listProviders()) {
    if (!provider.dailyHistory || config.disabledProviders.includes(provider.id)) continue;
    collected.push([provider.id, await provider.dailyHistory(sinceMs)]);
  }
  // Recarrega: um ciclo pode ter gravado o dia de hoje enquanto isto lia.
  const history = await loadHistory();
  for (const [id, days] of collected) {
    for (const [day, usage] of days) {
      if (day !== today) recordDay(history, day, id, usage);
    }
  }
  history.backfilledAt = isoSeconds(Date.now());
  await saveHistory(history, now);
}

// Histórico diário em CSV (dia, conta, tokens, custo em US$), para planilhas.
export async function historyCsv() {
  const history = await loadHistory();
  const lines = ['dia,conta,tokens,custo_usd'];
  for (const day of Object.keys(history.days).sort()) {
    for (const [id, usage] of Object.entries(history.days[day])) {
      lines.push(`${day},${id},${usage.tokens ?? 0},${(usage.costUsd ?? 0).toFixed(2)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
