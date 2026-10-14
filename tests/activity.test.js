import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CollectionScheduler, activityPaths, watchActivity } from '../collector/src/activity.js';
import { tempDir } from './helpers.js';

const fakeClock = (start = 0) => {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
};

test('sem uso, a próxima coleta fica no intervalo normal', () => {
  const clock = fakeClock(1_000_000);
  const scheduler = new CollectionScheduler({ now: clock.now });
  scheduler.ran(120_000);
  assert.equal(scheduler.dueAt, 1_120_000);
});

test('uso antecipa a coleta, respeitando um minuto desde a última', () => {
  const clock = fakeClock(1_000_000);
  const scheduler = new CollectionScheduler({ now: clock.now });
  scheduler.ran(300_000);
  clock.advance(5_000);
  scheduler.activity();
  assert.equal(scheduler.dueAt, 1_060_000, 'colado na última coleta: espera completar 1 min');
  clock.advance(100_000);
  scheduler.ran(300_000);
  clock.advance(120_000);
  scheduler.activity();
  assert.equal(scheduler.dueAt, clock.now() + 10_000, 'longe da última: 10 s para o arquivo assentar');
});

test('uso nunca adia uma coleta que já ia acontecer antes', () => {
  const clock = fakeClock(1_000_000);
  const scheduler = new CollectionScheduler({ now: clock.now });
  scheduler.ran(30_000);
  clock.advance(25_000);
  scheduler.activity();
  assert.equal(scheduler.dueAt, 1_030_000);
});

test('wait() acorda mais cedo quando chega uso durante a espera', async () => {
  const scheduler = new CollectionScheduler({ minGapMs: 0, settleMs: 20 });
  scheduler.ran(60_000);
  const started = Date.now();
  const waiting = scheduler.wait();
  setTimeout(() => scheduler.activity(), 10);
  await waiting;
  assert.ok(Date.now() - started < 1000);
});

test('observa as pastas de conversa e só reage a arquivos .jsonl', async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  const paths = await activityPaths(home);
  assert.deepEqual(paths, [path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions')]);

  let hits = 0;
  const stop = watchActivity(paths, () => { hits += 1; });
  t.after(stop);
  await fs.writeFile(path.join(home, '.claude', 'projects', 'p', 'nota.txt'), 'x');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(hits, 0, 'arquivo que não é conversa é ignorado');
  await fs.writeFile(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), '{}\n');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(hits > 0, 'conversa nova dispara');
});
