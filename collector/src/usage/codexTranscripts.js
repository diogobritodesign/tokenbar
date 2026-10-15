import { platform } from '../platform/index.js';
import { messageCostUsd } from '../pricing.js';
import { basename, sep } from '../util/path.js';
import { localDayKey } from './claudeTranscripts.js';

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const decoder = new TextDecoder();
const MAX_SESSIONS = 6;
const roundCents = (value) => Math.round(value * 100) / 100;

function startOfLocalDay(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

// [entrada (sem cache), saída, escrita de cache, 0, leitura de cache, modelo]
function usageTuple(usage, model) {
  const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const input = n(usage.input_tokens);
  const cached = Math.min(input, n(usage.cached_input_tokens));
  const output = n(usage.output_tokens) + n(usage.reasoning_output_tokens);
  return [input - cached, output, n(usage.cache_write_input_tokens), 0, cached, String(model || '')];
}

function tupleTotals([input, output, cacheWrite, _unused, cacheRead, model]) {
  const cost = messageCostUsd(model, {
    input,
    output,
    cacheWrite5m: cacheWrite,
    cacheWrite1h: 0,
    cacheRead
  });
  return {
    tokens: input + output + cacheWrite + cacheRead,
    costUsd: cost ?? 0,
    priced: cost !== null
  };
}

function parseCodexLine(line, modelHint) {
  if (!line.includes('"token_usage_record"') && !line.includes('"session_meta"') && !line.includes('"world_state"')) {
    return null;
  }
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.type === 'session_meta') {
    return {
      kind: 'meta',
      cwd: entry.payload?.cwd || null,
      sessionId: entry.payload?.session_id || entry.payload?.id || null,
      model: entry.payload?.model || null
    };
  }
  if (entry?.type === 'world_state') {
    return {
      kind: 'meta',
      model: entry.payload?.state?.collaboration_mode?.model || entry.payload?.state?.model || null
    };
  }
  if (entry?.type !== 'token_usage_record' || !entry.payload?.usage) return null;
  const at = Date.parse(entry.timestamp);
  const id = entry.payload.response_id || `${entry.payload.turn_id}:${entry.ordinal}`;
  if (!Number.isFinite(at) || !id) return null;
  return {
    kind: 'usage',
    id,
    at,
    sessionId: entry.payload.session_id || null,
    tuple: usageTuple(entry.payload.usage, modelHint)
  };
}

async function readAppended(file, size, cached, dayStartMs) {
  const state = cached && cached.offset <= size
    ? cached
    : { offset: 0, messages: {}, model: null, cwd: null, sessionId: null };
  if (state.offset === size) return state;

  let position = state.offset;
  let pending = new Uint8Array(0);
  while (position < size) {
    const chunk = await platform.readRange(file, position, Math.min(CHUNK_BYTES, size - position));
    if (chunk.length === 0) break;
    position += chunk.length;
    let data = chunk;
    if (pending.length) {
      data = new Uint8Array(pending.length + chunk.length);
      data.set(pending);
      data.set(chunk, pending.length);
    }
    let start = 0;
    let newline;
    while ((newline = data.indexOf(NEWLINE, start)) !== -1) {
      const parsed = parseCodexLine(decoder.decode(data.subarray(start, newline)), state.model);
      if (parsed?.kind === 'meta') {
        if (parsed.model) state.model = parsed.model;
        if (parsed.cwd) state.cwd = parsed.cwd;
        if (parsed.sessionId) state.sessionId = parsed.sessionId;
      } else if (parsed?.kind === 'usage' && parsed.at >= dayStartMs) {
        const tuple = parsed.tuple.slice();
        if (!tuple[5] && state.model) tuple[5] = state.model;
        state.messages[parsed.id] = tuple;
        state.sessionId ??= parsed.sessionId;
        state.lastAt = Math.max(state.lastAt || 0, parsed.at);
      }
      start = newline + 1;
    }
    pending = data.slice(start);
  }
  state.offset = position - pending.length;
  return state;
}

async function listJsonlFiles(root) {
  return (await platform.listFiles(root, '.jsonl')).sort();
}

export async function codexUsageToday(sessionsDir, cache, now = new Date()) {
  const dayStartMs = startOfLocalDay(now);
  const prefix = sessionsDir + sep;
  const seen = new Set();
  const merged = new Map();

  for (const file of await listJsonlFiles(sessionsDir)) {
    const stat = await platform.stat(file);
    if (!stat || stat.mtimeMs < dayStartMs) continue;
    seen.add(file);
    try {
      cache.files[file] = await readAppended(file, stat.size, cache.files[file], dayStartMs);
    } catch {
      continue;
    }
    for (const [id, tuple] of Object.entries(cache.files[file].messages)) {
      merged.set(id, { tuple, file });
    }
  }

  for (const file of Object.keys(cache.files)) {
    if (file.startsWith(prefix) && !seen.has(file)) delete cache.files[file];
  }

  let tokens = 0;
  let costUsd = 0;
  let unpricedTokens = 0;
  const breakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const models = new Map();
  const sessions = new Map();
  const add = (map, key, extra, totals) => {
    const item = map.get(key) || { ...extra, tokens: 0, costUsd: 0 };
    item.tokens += totals.tokens;
    item.costUsd += totals.costUsd;
    map.set(key, item);
    return item;
  };

  for (const { tuple, file } of merged.values()) {
    const totals = tupleTotals(tuple);
    tokens += totals.tokens;
    costUsd += totals.costUsd;
    if (!totals.priced) unpricedTokens += totals.tokens;
    breakdown.input += tuple[0];
    breakdown.output += tuple[1];
    breakdown.cacheWrite += tuple[2];
    breakdown.cacheRead += tuple[4];
    add(models, tuple[5] || 'unknown', { model: tuple[5] || 'unknown' }, totals);
    const state = cache.files[file];
    const session = add(sessions, state.sessionId || file, { project: null, path: null, lastAt: 0 }, totals);
    if (state.cwd && !session.project) {
      session.project = basename(state.cwd);
      session.path = state.cwd;
    }
    session.lastAt = Math.max(session.lastAt, state.lastAt || 0);
  }

  const byCost = (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens;
  return {
    tokens,
    costUsd: roundCents(costUsd),
    unpricedTokens,
    breakdown,
    models: [...models.values()].sort(byCost).map((m) => ({ ...m, costUsd: roundCents(m.costUsd) })),
    sessions: [...sessions.values()]
      .sort(byCost)
      .slice(0, MAX_SESSIONS)
      .map((s) => ({
        project: s.project || null,
        path: s.path || null,
        tokens: s.tokens,
        costUsd: roundCents(s.costUsd),
        lastAt: s.lastAt ? new Date(s.lastAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null
      }))
  };
}

export async function codexDailyHistory(sessionsDir, sinceMs) {
  const byId = new Map();
  for (const file of await listJsonlFiles(sessionsDir)) {
    try {
      const stat = await platform.stat(file);
      if (!stat || stat.mtimeMs < sinceMs) continue;
      let model = null;
      await platform.readLines(file, (line) => {
        const parsed = parseCodexLine(line, model);
        if (parsed?.kind === 'meta') {
          if (parsed.model) model = parsed.model;
          return;
        }
        if (parsed?.kind === 'usage' && parsed.at >= sinceMs) {
          const tuple = parsed.tuple.slice();
          if (!tuple[5] && model) tuple[5] = model;
          byId.set(parsed.id, { at: parsed.at, tuple });
        }
      });
    } catch {
      // arquivo sumiu ou ilegível
    }
  }
  const days = new Map();
  for (const { at, tuple } of byId.values()) {
    const key = localDayKey(new Date(at));
    const totals = tupleTotals(tuple);
    const day = days.get(key) || { tokens: 0, costUsd: 0 };
    day.tokens += totals.tokens;
    day.costUsd += totals.costUsd;
    days.set(key, day);
  }
  for (const day of days.values()) day.costUsd = roundCents(day.costUsd);
  return days;
}
