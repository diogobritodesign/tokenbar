import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// paths.js lê as variáveis XDG ao ser importado, então elas vêm antes do import.
const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenbar-pace-'));
process.env.XDG_CACHE_HOME = cacheHome;
const { applyRecentPace } = await import('../collector/src/pace.js');
const samplesFile = path.join(cacheHome, 'tokenbar', 'samples.json');

test.after(() => fs.rm(cacheHome, { recursive: true, force: true }));

const MIN = 60000;
const NOW = Date.parse('2026-10-13T12:00:00Z');
const session = (id, usedPct, resetInMin) => ({
  id,
  status: 'ok',
  windows: [{ label: '5h', windowMinutes: 300, usedPct, resetsAt: new Date(NOW + resetInMin * MIN).toISOString() }]
});
const seed = async (samples) => {
  await fs.mkdir(path.dirname(samplesFile), { recursive: true });
  await fs.writeFile(samplesFile, JSON.stringify(samples));
};

test('projeta o esgotamento pelo ritmo dos últimos minutos', async () => {
  const reset = NOW + 120 * MIN;
  await seed({ 'a//5h': [[NOW - 30 * MIN, 40, reset]] });
  const providers = [session('a', 70, 120)];
  await applyRecentPace(providers, NOW);
  // 30 pontos em 30 min -> faltam 30 pontos -> mais 30 min
  assert.deepEqual(providers[0].windows[0].pace, { basis: 'recent', exhaustsAt: '2026-10-13T12:30:00Z' });
});

test('sem consumo recente, ou com o reset chegando antes, não há previsão de esgotar', async () => {
  const reset = NOW + 20 * MIN;
  await seed({ 'parado//5h': [[NOW - 30 * MIN, 40, reset]], 'lento//5h': [[NOW - 30 * MIN, 39, reset]] });
  const providers = [session('parado', 40, 20), session('lento', 40, 20)];
  await applyRecentPace(providers, NOW);
  assert.deepEqual(providers[0].windows[0].pace, { basis: 'recent', exhaustsAt: null });
  assert.deepEqual(providers[1].windows[0].pace, { basis: 'recent', exhaustsAt: null });
});

test('com pouco histórico não cria o campo (a interface usa a média da janela)', async () => {
  const reset = NOW + 120 * MIN;
  await seed({ 'novo//5h': [[NOW - 4 * MIN, 10, reset]] });
  const providers = [session('novo', 30, 120), session('inedito', 30, 120)];
  await applyRecentPace(providers, NOW);
  assert.equal(providers[0].windows[0].pace, undefined);
  assert.equal(providers[1].windows[0].pace, undefined);
});

test('amostras de uma janela anterior (outro reset) são descartadas', async () => {
  await seed({ 'a//5h': [[NOW - 30 * MIN, 95, NOW - 10 * MIN]] });
  const providers = [session('a', 5, 290)];
  await applyRecentPace(providers, NOW);
  assert.equal(providers[0].windows[0].pace, undefined);
  const saved = JSON.parse(await fs.readFile(samplesFile, 'utf8'));
  assert.equal(saved['a//5h'].length, 1);
  assert.equal(saved['a//5h'][0][1], 5);
});

test('contas com erro e janelas sem reset ou duração não são amostradas', async () => {
  await seed({});
  const providers = [
    { ...session('erro', 50, 60), status: 'unauthorized' },
    { id: 'mensal', status: 'ok', windows: [{ label: 'Chat', usedPct: 10, resetsAt: new Date(NOW + MIN).toISOString() }] },
    { id: 'semreset', status: 'ok', windows: [{ label: '5h', windowMinutes: 300, usedPct: 0, resetsAt: null }] }
  ];
  await applyRecentPace(providers, NOW);
  assert.deepEqual(JSON.parse(await fs.readFile(samplesFile, 'utf8')), {});
});

test('não acumula amostras iguais em sequência rápida', async () => {
  await seed({});
  for (const offset of [0, 1, 2, 6]) {
    await applyRecentPace([session('a', 10, 200)], NOW + offset * MIN);
  }
  const saved = JSON.parse(await fs.readFile(samplesFile, 'utf8'));
  assert.equal(saved['a//5h'].length, 2);
});
