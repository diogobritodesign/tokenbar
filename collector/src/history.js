import { readJson, writeJsonAtomic } from './files.js';
import { historyFile } from './paths.js';
import { localDayKey } from './usage/claudeTranscripts.js';

const HISTORY_VERSION = 1;
const KEEP_DAYS = 120;
export const BACKFILL_DAYS = 30;
export const SERIES_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// { version, backfilledAt, days: { 'AAAA-MM-DD': { <id do provedor>: { tokens, costUsd } } } }
export async function loadHistory() {
  const history = await readJson(historyFile());
  if (history?.version === HISTORY_VERSION && history.days && typeof history.days === 'object') return history;
  return { version: HISTORY_VERSION, backfilledAt: null, days: {} };
}

export function recordDay(history, dayKey, providerId, usage) {
  if (!usage || !Number.isFinite(usage.tokens)) return;
  history.days[dayKey] ??= {};
  history.days[dayKey][providerId] = { tokens: usage.tokens, costUsd: usage.costUsd ?? 0 };
}

export async function saveHistory(history, now = new Date()) {
  const oldest = localDayKey(new Date(now.getTime() - KEEP_DAYS * DAY_MS));
  for (const key of Object.keys(history.days)) {
    if (key < oldest) delete history.days[key];
  }
  await writeJsonAtomic(historyFile(), history);
}

function dayKeysBack(now, count) {
  const keys = [];
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    keys.unshift(localDayKey(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return keys;
}

// Série diária (todas as contas somadas) e totais de 7 e 30 dias, hoje incluso.
export function summarize(history, now = new Date()) {
  const series = dayKeysBack(now, SERIES_DAYS).map((day) => {
    let tokens = 0;
    let costUsd = 0;
    for (const usage of Object.values(history.days[day] || {})) {
      tokens += usage.tokens || 0;
      costUsd += usage.costUsd || 0;
    }
    return { day, tokens, costUsd: Math.round(costUsd * 100) / 100 };
  });
  const total = (days) => {
    const slice = series.slice(-days);
    return {
      tokens: slice.reduce((sum, d) => sum + d.tokens, 0),
      costUsd: Math.round(slice.reduce((sum, d) => sum + d.costUsd, 0) * 100) / 100
    };
  };
  return { series, last7: total(7), last30: total(30), complete: Boolean(history.backfilledAt) };
}
