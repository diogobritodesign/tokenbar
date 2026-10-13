import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { messageCostUsd } from '../pricing.js';

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const MAX_SESSIONS = 6;

export function localDayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

const roundCents = (value) => Math.round(value * 100) / 100;

// [entrada, saída, escrita de cache 5 min, escrita de cache 1 h, leitura de cache, modelo]
function usageTuple(usage, model) {
  const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const written = n(usage.cache_creation_input_tokens);
  const written1h = Math.min(written, n(usage.cache_creation?.ephemeral_1h_input_tokens));
  return [
    n(usage.input_tokens),
    n(usage.output_tokens),
    written - written1h,
    written1h,
    n(usage.cache_read_input_tokens),
    String(model || '')
  ];
}

function tupleTotals([input, output, cacheWrite5m, cacheWrite1h, cacheRead, model]) {
  const cost = messageCostUsd(model, { input, output, cacheWrite5m, cacheWrite1h, cacheRead });
  return {
    tokens: input + output + cacheWrite5m + cacheWrite1h + cacheRead,
    // Modelo fora da tabela conta nos tokens, mas não entra no custo;
    // `priced` deixa isso visível para quem mostra o total.
    costUsd: cost ?? 0,
    priced: cost !== null
  };
}

// Devolve a mensagem de assistente com `usage` contida na linha, ou null.
function parseUsageLine(line) {
  // Filtro barato antes do JSON.parse: a maioria das linhas não tem usage.
  if (!line.includes('"usage"')) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const message = entry?.message;
  if (entry?.type !== 'assistant' || !message?.usage || message.model === '<synthetic>') return null;
  const at = Date.parse(entry.timestamp);
  const id = message.id || entry.uuid;
  if (!Number.isFinite(at) || !id) return null;
  return { id, at, entry, tuple: usageTuple(message.usage, message.model) };
}

// Lê só o que foi acrescentado ao arquivo desde a última passada.
async function readAppended(file, size, cached, dayStartMs) {
  const state = cached && cached.offset <= size ? cached : { offset: 0, messages: {} };
  if (state.offset === size) return state;

  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = state.offset;
    let pending = Buffer.alloc(0);
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let data = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let newline;
      while ((newline = data.indexOf(NEWLINE)) !== -1) {
        const parsed = parseUsageLine(data.toString('utf8', 0, newline));
        if (parsed && parsed.at >= dayStartMs) {
          // A mesma mensagem aparece em várias linhas (uma por bloco de conteúdo);
          // a última traz a contagem final, então ela sobrescreve as anteriores.
          state.messages[parsed.id] = parsed.tuple;
          state.sessionId ??= parsed.entry.sessionId || null;
          if (parsed.entry.cwd) state.cwd = parsed.entry.cwd;
          state.lastAt = Math.max(state.lastAt || 0, parsed.at);
        }
        data = data.subarray(newline + 1);
      }
      pending = Buffer.from(data);
    }
    // Uma linha ainda sem "\n" está sendo escrita: fica para a próxima passada.
    state.offset = position - pending.length;
  } finally {
    await handle.close();
  }
  return state;
}

async function listJsonlFiles(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

// Uso de hoje (dia local) dos transcripts em `projectsDir`, deduplicado por id
// de mensagem: total, custo pela tabela da API, divisão por modelo e as
// sessões que mais gastaram. `cache` é mutado e guarda, por arquivo, até onde
// já foi lido.
export async function claudeUsageToday(projectsDir, cache, now = new Date()) {
  const dayStartMs = startOfLocalDay(now);
  const prefix = projectsDir + path.sep;
  const seen = new Set();
  const merged = new Map();

  for (const file of await listJsonlFiles(projectsDir)) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < dayStartMs) continue;
    seen.add(file);
    try {
      cache.files[file] = await readAppended(file, stat.size, cache.files[file], dayStartMs);
    } catch {
      continue;
    }
    for (const [id, tuple] of Object.entries(cache.files[file].messages)) {
      const previous = merged.get(id);
      if (!previous || tuple[1] >= previous.tuple[1]) merged.set(id, { tuple, file });
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
    breakdown.cacheWrite += tuple[2] + tuple[3];
    breakdown.cacheRead += tuple[4];
    add(models, tuple[5] || 'unknown', { model: tuple[5] || 'unknown' }, totals);

    // Subagentes gravam em arquivos próprios com o sessionId da sessão-mãe,
    // então caem na mesma linha.
    const state = cache.files[file];
    const session = add(sessions, state.sessionId || file, { project: null, path: null, lastAt: 0 }, totals);
    if (state.cwd && !session.project) {
      session.project = path.basename(state.cwd);
      session.path = state.cwd;
    }
    session.lastAt = Math.max(session.lastAt, state.lastAt || 0);
  }

  const byCost = (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens;
  return {
    tokens,
    costUsd: roundCents(costUsd),
    // Quantos tokens ficaram fora do custo por serem de modelo sem preço na tabela.
    unpricedTokens,
    breakdown,
    models: [...models.values()].sort(byCost).map((m) => ({ ...m, costUsd: roundCents(m.costUsd) })),
    sessions: [...sessions.values()]
      .sort(byCost)
      .slice(0, MAX_SESSIONS)
      .map((s) => ({
        // null quando a sessão não registrou a pasta; a interface mostra "sem projeto"
        project: s.project || null,
        path: s.path || null,
        tokens: s.tokens,
        costUsd: roundCents(s.costUsd),
        lastAt: s.lastAt ? new Date(s.lastAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null
      }))
  };
}

// Reconstrói o uso por dia a partir dos transcripts modificados desde
// `sinceMs`. É uma leitura completa (pode levar dezenas de segundos em
// centenas de MB), feita uma única vez para semear o histórico.
export async function claudeDailyHistory(projectsDir, sinceMs) {
  const byId = new Map();
  for (const file of await listJsonlFiles(projectsDir)) {
    try {
      if ((await fs.stat(file)).mtimeMs < sinceMs) continue;
      const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        const parsed = parseUsageLine(line);
        // Só o instante e a contagem: guardar a entrada inteira custaria centenas de MB.
        if (parsed && parsed.at >= sinceMs) byId.set(parsed.id, { at: parsed.at, tuple: parsed.tuple });
      }
    } catch {
      // arquivo sumiu ou é ilegível: segue para o próximo
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
