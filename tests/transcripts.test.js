import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { claudeDailyHistory, claudeUsageToday, localDayKey } from '../collector/src/usage/claudeTranscripts.js';
import { assistantLine, tempDir, usage } from './helpers.js';

const NOON = new Date(2026, 9, 13, 12, 0, 0);
const at = (hours) => new Date(2026, 9, 13, hours, 0, 0).getTime();
const newCache = () => ({ files: {} });

async function write(dir, name, lines) {
  const file = path.join(dir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((line) => `${line}\n`).join(''));
  await fs.utimes(file, NOON, NOON);
  return file;
}

test('soma os tokens de hoje e ignora os de ontem', async (t) => {
  const dir = await tempDir(t);
  await write(dir, 'p/a.jsonl', [
    assistantLine({ id: 'm1', at: at(9), usage: usage(100, 200, 1000) }),
    assistantLine({ id: 'm0', at: at(-3), usage: usage(999, 999, 999) }),
    JSON.stringify({ type: 'user', timestamp: new Date(at(9)).toISOString(), message: { usage: usage(5, 5) } })
  ]);
  const result = await claudeUsageToday(dir, newCache(), NOON);
  assert.equal(result.tokens, 1300);
  assert.deepEqual(result.breakdown, { input: 100, output: 200, cacheWrite: 0, cacheRead: 1000 });
});

test('a mesma mensagem repetida conta uma vez, com a contagem final', async (t) => {
  const dir = await tempDir(t);
  await write(dir, 'p/a.jsonl', [
    assistantLine({ id: 'm1', at: at(9), usage: usage(100, 10) }),
    assistantLine({ id: 'm1', at: at(9), usage: usage(100, 250) })
  ]);
  // Cópia da mesma mensagem em outro arquivo (sessão retomada).
  await write(dir, 'p/b.jsonl', [assistantLine({ id: 'm1', at: at(9), usage: usage(100, 250) })]);
  const result = await claudeUsageToday(dir, newCache(), NOON);
  assert.equal(result.tokens, 350);
});

test('custo usa a tabela e separa escrita de cache de 5 min e de 1 h', async (t) => {
  const dir = await tempDir(t);
  await write(dir, 'p/a.jsonl', [assistantLine({ id: 'm1', at: at(9), usage: usage(1e6, 0, 0, 1e6, 1e6) })]);
  const result = await claudeUsageToday(dir, newCache(), NOON);
  // 4 (entrada) + 5 (escrita 5 min) + 8 (escrita 1 h)
  assert.equal(result.costUsd, 17);
  assert.equal(result.unpricedTokens, 0);
});

test('modelo sem preço entra nos tokens e é sinalizado como não precificado', async (t) => {
  const dir = await tempDir(t);
  await write(dir, 'p/a.jsonl', [
    assistantLine({ id: 'm1', at: at(9), model: 'modelo-novo', usage: usage(500, 500) }),
    assistantLine({ id: 'm2', at: at(9), model: '<synthetic>', usage: usage(7, 7) })
  ]);
  const result = await claudeUsageToday(dir, newCache(), NOON);
  assert.equal(result.tokens, 1000);
  assert.equal(result.costUsd, 0);
  assert.equal(result.unpricedTokens, 1000);
});

test('agrupa por modelo e por sessão, juntando subagentes à sessão-mãe', async (t) => {
  const dir = await tempDir(t);
  await write(dir, 'p/a.jsonl', [
    assistantLine({ id: 'm1', at: at(9), usage: usage(0, 1e6), sessionId: 's1', cwd: '/home/u/alpha' }),
    assistantLine({ id: 'm2', at: at(10), model: 'claude-haiku-5-5', usage: usage(0, 1e6), sessionId: 's1', cwd: '/home/u/alpha' })
  ]);
  await write(dir, 'p/s1/subagents/x.jsonl', [
    assistantLine({ id: 'm3', at: at(11), usage: usage(0, 1e6), sessionId: 's1', cwd: '/home/u/alpha' })
  ]);
  await write(dir, 'q/b.jsonl', [
    assistantLine({ id: 'm4', at: at(9), usage: usage(0, 5e5), sessionId: 's2', cwd: '/home/u/beta' })
  ]);
  const result = await claudeUsageToday(dir, newCache(), NOON);
  assert.deepEqual(result.models.map((m) => [m.model, m.tokens, m.costUsd]), [
    ['claude-opus-5-5', 2.5e6, 50],
    ['claude-haiku-5-5', 1e6, 0.5]
  ]);
  assert.deepEqual(result.sessions.map((s) => [s.project, s.path, s.tokens]), [
    ['alpha', '/home/u/alpha', 3e6],
    ['beta', '/home/u/beta', 5e5]
  ]);
});

test('leitura incremental: só o que foi acrescentado é lido na segunda passada', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, 'p/a.jsonl', [assistantLine({ id: 'm1', at: at(9), usage: usage(10, 10) })]);
  const cache = newCache();
  assert.equal((await claudeUsageToday(dir, cache, NOON)).tokens, 20);
  const firstOffset = cache.files[file].offset;

  // Uma linha completa e outra ainda sendo escrita (sem "\n" no fim).
  await fs.appendFile(file, `${assistantLine({ id: 'm2', at: at(10), usage: usage(30, 30) })}\n{"type":"assist`);
  await fs.utimes(file, NOON, NOON);
  assert.equal((await claudeUsageToday(dir, cache, NOON)).tokens, 80);
  assert.ok(cache.files[file].offset > firstOffset);

  // A linha pela metade é concluída depois e entra na passada seguinte.
  const size = (await fs.stat(file)).size;
  assert.ok(cache.files[file].offset < size);
});

test('arquivo truncado ou trocado é relido do início', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, 'p/a.jsonl', [
    assistantLine({ id: 'm1', at: at(9), usage: usage(10, 10) }),
    assistantLine({ id: 'm2', at: at(9), usage: usage(10, 10) })
  ]);
  const cache = newCache();
  assert.equal((await claudeUsageToday(dir, cache, NOON)).tokens, 40);
  await write(dir, 'p/a.jsonl', [assistantLine({ id: 'm9', at: at(9), usage: usage(1, 1) })]);
  assert.equal((await claudeUsageToday(dir, cache, NOON)).tokens, 2);
  assert.ok(file);
});

test('pasta inexistente e linhas inválidas não quebram', async (t) => {
  const dir = await tempDir(t);
  assert.equal((await claudeUsageToday(path.join(dir, 'nao-existe'), newCache(), NOON)).tokens, 0);
  await write(dir, 'p/a.jsonl', ['{"usage" isto não é json', '', assistantLine({ id: 'm1', at: at(9), usage: usage(1, 2) })]);
  assert.equal((await claudeUsageToday(dir, newCache(), NOON)).tokens, 3);
});

test('histórico diário agrupa por dia local e deduplica entre arquivos', async (t) => {
  const dir = await tempDir(t);
  const yesterday = new Date(2026, 9, 12, 15, 0, 0).getTime();
  await write(dir, 'p/a.jsonl', [
    assistantLine({ id: 'm1', at: yesterday, usage: usage(0, 1e6) }),
    assistantLine({ id: 'm2', at: at(9), usage: usage(0, 2e6) })
  ]);
  await write(dir, 'p/b.jsonl', [assistantLine({ id: 'm1', at: yesterday, usage: usage(0, 1e6) })]);
  const days = await claudeDailyHistory(dir, new Date(2026, 9, 1).getTime());
  assert.deepEqual(days.get(localDayKey(new Date(yesterday))), { tokens: 1e6, costUsd: 20 });
  assert.deepEqual(days.get('2026-10-13'), { tokens: 2e6, costUsd: 40 });
});
