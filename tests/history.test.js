import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenbar-history-'));
process.env.XDG_STATE_HOME = stateHome;
const { loadHistory, recordDay, saveHistory, summarize } = await import('../collector/src/history.js');

test.after(() => fs.rm(stateHome, { recursive: true, force: true }));

const NOW = new Date(2026, 9, 13, 12, 0, 0);

test('histórico vazio quando não há arquivo', async () => {
  assert.deepEqual(await loadHistory(), { version: 1, backfilledAt: null, days: {} });
});

test('soma as contas por dia e calcula 7 e 30 dias com hoje incluso', async () => {
  const history = await loadHistory();
  recordDay(history, '2026-10-13', 'a', { tokens: 100, costUsd: 1.5 });
  recordDay(history, '2026-10-13', 'b', { tokens: 50, costUsd: 0.5 });
  recordDay(history, '2026-10-07', 'a', { tokens: 1000, costUsd: 10 });
  recordDay(history, '2026-10-06', 'a', { tokens: 7, costUsd: 7 });
  recordDay(history, '2026-09-14', 'a', { tokens: 30, costUsd: 30 });
  recordDay(history, '2026-09-13', 'a', { tokens: 999, costUsd: 999 });
  const summary = summarize(history, NOW);

  assert.equal(summary.series.length, 30);
  assert.deepEqual(summary.series.at(-1), { day: '2026-10-13', tokens: 150, costUsd: 2 });
  assert.equal(summary.series[0].day, '2026-09-14');
  assert.deepEqual(summary.last7, { tokens: 1150, costUsd: 12 });
  assert.deepEqual(summary.last30, { tokens: 1187, costUsd: 49 });
  assert.equal(summary.complete, false);
});

test('regravar o mesmo dia substitui em vez de somar', async () => {
  const history = await loadHistory();
  recordDay(history, '2026-10-13', 'a', { tokens: 100, costUsd: 1 });
  recordDay(history, '2026-10-13', 'a', { tokens: 250, costUsd: 3 });
  recordDay(history, '2026-10-13', 'a', null);
  recordDay(history, '2026-10-13', 'c', { tokens: NaN });
  assert.deepEqual(history.days['2026-10-13'], { a: { tokens: 250, costUsd: 3 } });
});

test('ao salvar, descarta dias além da retenção e relê o que gravou', async () => {
  const history = await loadHistory();
  recordDay(history, '2026-10-13', 'a', { tokens: 1, costUsd: 0 });
  recordDay(history, '2026-01-01', 'a', { tokens: 1, costUsd: 0 });
  history.backfilledAt = '2026-10-13T00:00:00Z';
  await saveHistory(history, NOW);
  const reloaded = await loadHistory();
  assert.deepEqual(Object.keys(reloaded.days), ['2026-10-13']);
  assert.equal(summarize(reloaded, NOW).complete, true);
});

test('arquivo corrompido ou de outra versão recomeça do zero', async () => {
  const file = path.join(stateHome, 'tokenbar', 'history.json');
  await fs.writeFile(file, '{ quebrado');
  assert.deepEqual((await loadHistory()).days, {});
  await fs.writeFile(file, JSON.stringify({ version: 99, days: { x: {} } }));
  assert.deepEqual((await loadHistory()).days, {});
});
