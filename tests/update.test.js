import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenbar-update-'));
process.env.XDG_CACHE_HOME = cacheHome;
const { checkForUpdate, installedVersion, isNewer } = await import('../collector/src/update.js');
test.after(() => fs.rm(cacheHome, { recursive: true, force: true }));

const SHA_OLD = 'aaaaaaa1111111111111111111111111111111aa';
const SHA_NEW = 'bbbbbbb2222222222222222222222222222222bb';
const versionFile = path.join(cacheHome, 'VERSION.json');
let calls = 0;
let latest = { sha: SHA_NEW, commit: { committer: { date: '2026-10-14T10:00:00Z' }, message: 'Add something\n\nlong body' } };
globalThis.fetch = async (url) => {
  calls += 1;
  assert.match(String(url), /api\.github\.com\/repos\/diogobritodesign\/tokenbar\/commits\/main$/);
  return new Response(JSON.stringify(latest), { status: 200 });
};

test('compara pelo commit instalado; sem commit, pela data da instalação', () => {
  assert.equal(isNewer({ commit: 'aaaaaaa' }, { sha: SHA_NEW }), true);
  assert.equal(isNewer({ commit: 'bbbbbbb' }, { sha: SHA_NEW }), false);
  assert.equal(isNewer({ installedAt: '2026-10-13T00:00:00Z' }, { sha: SHA_NEW, date: '2026-10-14T00:00:00Z' }), true);
  assert.equal(isNewer({ installedAt: '2026-10-15T00:00:00Z' }, { sha: SHA_NEW, date: '2026-10-14T00:00:00Z' }), false);
  assert.equal(isNewer(null, { sha: SHA_NEW }), false);
  assert.equal(isNewer({ commit: 'aaaaaaa' }, null), false);
});

test('arquivo de versão ausente ou inválido não quebra', async () => {
  assert.equal(await installedVersion(path.join(cacheHome, 'nao-existe.json')), null);
  await fs.writeFile(versionFile, JSON.stringify({ version: '0.1.0', commit: 'não é sha', installedAt: 'ontem' }));
  assert.deepEqual(await installedVersion(versionFile), { version: '0.1.0', commit: null, installedAt: null });
});

test('desligado ou sem instalação registrada: nenhuma consulta', async () => {
  const before = calls;
  assert.equal(await checkForUpdate({ enabled: false, versionFile }), null);
  assert.equal(await checkForUpdate({ enabled: true, versionFile: path.join(cacheHome, 'nao-existe.json') }), null);
  assert.equal(calls, before);
});

test('encontra versão nova, monta o link de comparação e consulta só uma vez por dia', async () => {
  await fs.writeFile(versionFile, JSON.stringify({ version: '0.1.0', commit: SHA_OLD, installedAt: '2026-10-13T00:00:00Z' }));
  const now = Date.parse('2026-10-14T12:00:00Z');
  const first = await checkForUpdate({ enabled: true, now, versionFile });
  assert.deepEqual(first, {
    installed: 'aaaaaaa', version: '0.1.0', available: true, latest: 'bbbbbbb', latestDate: '2026-10-14T10:00:00Z',
    summary: 'Add something', url: 'https://github.com/diogobritodesign/tokenbar/compare/aaaaaaa...bbbbbbb'
  });
  const before = calls;
  await checkForUpdate({ enabled: true, now: now + 3600e3, versionFile });
  assert.equal(calls, before, 'dentro de 24 h usa o que já sabe');
  await checkForUpdate({ enabled: true, now: now + 3600e3, versionFile, force: true });
  assert.equal(calls, before + 1, '"procurar agora" ignora o intervalo');
});

test('já na última versão: nada disponível', async () => {
  await fs.writeFile(versionFile, JSON.stringify({ version: '0.1.0', commit: SHA_NEW, installedAt: '2026-10-14T11:00:00Z' }));
  const result = await checkForUpdate({ enabled: true, force: true, versionFile });
  assert.equal(result.available, false);
});

test('GitHub fora do ar: mantém o último conhecido e tenta de novo mais tarde', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await fs.writeFile(versionFile, JSON.stringify({ version: '0.1.0', commit: SHA_OLD, installedAt: '2026-10-13T00:00:00Z' }));
  const result = await checkForUpdate({ enabled: true, force: true, versionFile });
  assert.equal(result.available, true);
  assert.equal(result.latest, 'bbbbbbb');
});
