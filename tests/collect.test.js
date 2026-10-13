import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assistantLine, usage } from './helpers.js';

// Ciclo completo do coletor numa pasta pessoal de mentira, com a rede simulada.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenbar-collect-'));
process.env.HOME = home;
process.env.XDG_CACHE_HOME = path.join(home, 'cache');
process.env.XDG_STATE_HOME = path.join(home, 'state');
process.env.XDG_CONFIG_HOME = path.join(home, 'config');
// Sem idioma no config.json, o coletor segue o do sistema.
process.env.LANG = 'pt_BR.UTF-8';
delete process.env.LC_ALL;
delete process.env.LC_MESSAGES;

const SECRET = 'sk-ant-oat01-SEGREDO-DE-TESTE';
const calls = [];
let usageReply = () => new Response(JSON.stringify({
  five_hour: { utilization: 17, resets_at: new Date(Date.now() + 2 * 3600e3).toISOString() },
  seven_day: { utilization: 42, resets_at: new Date(Date.now() + 4 * 86400e3).toISOString() }
}), { status: 200 });

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), auth: init?.headers?.authorization });
  if (String(url).includes('api.anthropic.com')) return usageReply();
  if (String(url).includes('USD-BRL')) return new Response(JSON.stringify({ USDBRL: { bid: '5.00' } }), { status: 200 });
  if (String(url).includes('status.claude.com')) {
    return new Response(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }), { status: 200 });
  }
  throw new Error('rede indisponível no teste');
};

async function writeAccount(dir, { expiresAt }) {
  await fs.mkdir(path.join(dir, 'projects', 'p'), { recursive: true });
  await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: SECRET, refreshToken: `${SECRET}-refresh`, expiresAt, subscriptionType: 'pro' }
  }));
  await fs.writeFile(path.join(dir, 'projects', 'p', 's.jsonl'),
    `${assistantLine({ id: `m-${path.basename(dir)}`, at: Date.now(), usage: usage(1000, 500) })}\n`);
}

await writeAccount(path.join(home, '.claude'), { expiresAt: Date.now() + 3600e3 });
await writeAccount(path.join(home, '.claude-extra'), { expiresAt: Date.now() - 1000 });

const { collectOnce, loadConfig, historyCsv } = await import('../collector/src/collect.js');
const stateFile = path.join(home, 'cache', 'tokenbar', 'state.json');
const readState = async () => JSON.parse(await fs.readFile(stateFile, 'utf8'));
const byId = (state, id) => state.providers.find((p) => p.id === id);

test.after(() => fs.rm(home, { recursive: true, force: true }));

test('grava o estado com as contas encontradas, limites, uso e custo', async () => {
  await collectOnce(await loadConfig());
  const state = await readState();

  assert.equal(state.version, 1);
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(state.accounts.map((a) => [a.id, a.enabled]), [['claude-main', true], ['claude-2', true]]);
  assert.deepEqual(state.fx.usdBrl, 5);
  assert.equal(state.services[0].indicator, 'none');

  const main = byId(state, 'claude-main');
  assert.equal(main.status, 'ok');
  assert.equal(main.plan, 'Pro');
  assert.deepEqual(main.windows.map((w) => [w.kind, w.usedPct]), [['session', 17], ['weekly', 42]]);
  assert.equal(main.tokensToday, 1500);
  assert.equal(main.costTodayUsd, 0.01);
  assert.equal(main.costPartial, false);
  assert.equal(main.sessionsToday[0].project, 'projeto-a');
  assert.equal(state.usage.series.at(-1).tokens, 3000);
});

test('token expirado não gera requisição e vira "unauthorized" com a dica', async () => {
  const state = await readState();
  const extra = byId(state, 'claude-2');
  assert.equal(extra.status, 'unauthorized');
  assert.match(extra.error, /abra o Claude Code/);
  assert.equal(extra.tokensToday, 1500, 'o uso local é lido mesmo sem login');
  assert.equal(calls.filter((c) => c.url.includes('api.anthropic.com')).length, 1);
});

test('nenhuma credencial vaza para os arquivos gravados', async () => {
  for (const dir of ['cache', 'state']) {
    for (const entry of await fs.readdir(path.join(home, dir, 'tokenbar'))) {
      const text = await fs.readFile(path.join(home, dir, 'tokenbar', entry), 'utf8');
      assert.ok(!text.includes('SEGREDO'), `${entry} contém a credencial`);
      assert.ok(!/Bearer/i.test(text), `${entry} contém cabeçalho de autorização`);
    }
  }
  assert.ok(calls.some((c) => c.auth === `Bearer ${SECRET}`), 'o token só segue no cabeçalho da requisição');
});

test('os arquivos das ferramentas não são alterados', async () => {
  const credentials = JSON.parse(await fs.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8'));
  assert.equal(credentials.claudeAiOauth.accessToken, SECRET);
  assert.deepEqual(await fs.readdir(path.join(home, '.claude')), ['.credentials.json', 'projects']);
});

test('HTTP 429 mantém o último valor e suspende novas consultas por 5 min', async () => {
  usageReply = () => new Response('{}', { status: 429 });
  const before = calls.length;
  await collectOnce(await loadConfig());
  let main = byId(await readState(), 'claude-main');
  assert.equal(main.status, 'rate_limited');
  assert.deepEqual(main.windows.map((w) => w.usedPct), [17, 42]);
  const wait = Date.parse(main.rateLimitedUntil) - Date.now();
  assert.ok(wait > 4.5 * 60e3 && wait <= 5 * 60e3 + 2000, `espera de ${wait} ms`);

  usageReply = () => { throw new Error('não deveria consultar durante a espera'); };
  await collectOnce(await loadConfig());
  main = byId(await readState(), 'claude-main');
  assert.equal(main.status, 'rate_limited');
  assert.equal(calls.slice(before).filter((c) => c.url.includes('api.anthropic.com')).length, 1);
});

test('erro de rede em uma conta não derruba o ciclo nem as outras', async () => {
  const stateBefore = await readState();
  // Zera a espera do 429 para a próxima consulta acontecer e falhar.
  byId(stateBefore, 'claude-main').rateLimitedUntil = null;
  await fs.writeFile(stateFile, JSON.stringify(stateBefore));
  usageReply = () => { throw new TypeError('fetch failed'); };
  await collectOnce(await loadConfig());
  const state = await readState();
  assert.equal(byId(state, 'claude-main').status, 'error');
  assert.equal(byId(state, 'claude-main').error, 'sem conexão com o servidor');
  assert.equal(byId(state, 'claude-2').status, 'unauthorized');
});

test('conta desligada na configuração some dos provedores mas segue listada', async () => {
  await fs.mkdir(path.join(home, 'config', 'tokenbar'), { recursive: true });
  await fs.writeFile(path.join(home, 'config', 'tokenbar', 'config.json'),
    JSON.stringify({ intervalSec: 5, disabledProviders: ['claude-2'] }));
  const config = await loadConfig();
  assert.equal(config.intervalSec, 60, 'intervalo abaixo do mínimo é corrigido');
  await collectOnce(config);
  const state = await readState();
  assert.deepEqual(state.providers.map((p) => p.id), ['claude-main']);
  assert.deepEqual(state.accounts.map((a) => [a.id, a.enabled]), [['claude-main', true], ['claude-2', false]]);
});

test('exportação em CSV lista dia, conta, tokens e custo', async () => {
  const lines = (await historyCsv()).trim().split('\n');
  assert.equal(lines[0], 'dia,conta,tokens,custo_usd');
  assert.ok(lines.some((line) => /^\d{4}-\d{2}-\d{2},claude-main,1500,0\.01$/.test(line)));
});

test('com idioma inglês no config.json, os textos gravados saem em inglês', async () => {
  await fs.writeFile(path.join(home, 'config', 'tokenbar', 'config.json'), JSON.stringify({ language: 'en' }));
  const config = await loadConfig();
  assert.equal(config.language, 'en');
  await collectOnce(config);
  const state = await readState();
  assert.equal(byId(state, 'claude-main').error, 'could not reach the server');
  assert.match(byId(state, 'claude-2').error, /open Claude Code/);
  assert.equal(byId(state, 'claude-main').name, 'Claude (main)');
  assert.equal(byId(state, 'claude-main').windows[1].label, 'Semana', 'o último valor conhecido é mantido como estava');
});
