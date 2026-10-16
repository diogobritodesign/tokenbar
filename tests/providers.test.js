import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import * as antigravity from '../collector/src/providers/antigravity.js';
import * as claude from '../collector/src/providers/claude.js';
import * as codex from '../collector/src/providers/codex.js';
import * as copilot from '../collector/src/providers/copilot.js';
import * as cursor from '../collector/src/providers/cursor.js';
import { setLanguage } from '../collector/src/i18n.js';
import { tempDir } from './helpers.js';

// JWT de mentira só para testes (payload: {"sub":"google-oauth2|user_TEST123"}).
function fakeJwt(sub = 'google-oauth2|user_TEST123') {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

// Rótulos e nomes abaixo são os de português.
test.beforeEach(() => setLanguage('pt'));

test('Claude: janelas de 5 h e semanal, com duração e percentual limitado a 0-100', () => {
  const windows = claude.mapWindows({
    five_hour: { utilization: 17.4, resets_at: '2026-10-13T15:00:00.281Z' },
    seven_day: { utilization: 142, resets_at: null },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3, resets_at: '2026-10-17T09:00:00Z' }
  });
  assert.deepEqual(windows, [
    { kind: 'session', label: '5h', windowMinutes: 300, usedPct: 17, resetsAt: '2026-10-13T15:00:00Z' },
    { kind: 'weekly', label: 'Semana', windowMinutes: 10080, usedPct: 100, resetsAt: null },
    { kind: 'weekly-model', label: 'Sonnet', windowMinutes: 10080, usedPct: 3, resetsAt: '2026-10-17T09:00:00Z' }
  ]);
  assert.deepEqual(claude.mapWindows({}), []);
});

test('Claude: rótulo do plano', () => {
  assert.equal(claude.planLabel({ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' }), 'Pro');
  assert.equal(claude.planLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(claude.planLabel({}), null);
});

test('Claude: descobre a conta padrão e as pastas ~/.claude-<nome> com login ou conversas', async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, '.claude'));
  await fs.mkdir(path.join(home, '.claude-trabalho'));
  await fs.writeFile(path.join(home, '.claude-trabalho', '.credentials.json'), '{}');
  await fs.mkdir(path.join(home, '.claude-antiga', 'projects'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude-backup'));
  await fs.writeFile(path.join(home, '.claude-arquivo'), 'não é pasta');

  const accounts = await claude.discoverClaudeAccounts(home);
  assert.deepEqual(accounts.map((a) => [a.id, a.label, a.name]), [
    ['claude-main', 'CLD', 'Claude (principal)'],
    ['claude-2', 'CLD2', 'Claude (antiga)'],
    ['claude-3', 'CLD3', 'Claude (trabalho)']
  ]);
  const only = await claude.discoverClaudeAccounts(await tempDir(t));
  assert.deepEqual(only.map((a) => a.name), ['Claude']);
});

test('Antigravity: grupos viram janelas com 5 h antes de semanal', () => {
  const windows = antigravity.mapWindows({
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { window: 'weekly', remainingFraction: 0.64, resetTime: '2026-10-20T00:49:48Z' },
            { window: '5h', remainingFraction: 1, resetTime: '2026-10-13T19:44:43Z' },
            { window: 'monthly', remainingFraction: 0.5 },
            { window: '5h', remainingFraction: 0.1, disabled: true }
          ]
        },
        { displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 0 }] }
      ]
    }
  });
  assert.deepEqual(windows.map((w) => [w.group, w.label, w.usedPct, w.resetsAt]), [
    ['Gemini', '5h', 0, '2026-10-13T19:44:43Z'],
    ['Gemini', 'Semana', 36, '2026-10-20T00:49:48Z'],
    ['Claude/GPT', '5h', 100, null]
  ]);
  assert.deepEqual(antigravity.mapWindows(null), []);
});

test('Antigravity: plano sem o prefixo "Google AI"', () => {
  assert.equal(antigravity.planFrom({ userStatus: { userTier: { name: 'Google AI Pro' } } }), 'Pro');
  assert.equal(antigravity.planFrom({ userStatus: { planStatus: { planInfo: { planName: 'Free' } } } }), 'Free');
  assert.equal(antigravity.planFrom({}), null);
});

test('Copilot: cotas com franquia viram janelas mensais; ilimitada e sem franquia ficam de fora', () => {
  const windows = copilot.mapWindows({
    quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
    quota_snapshots: {
      chat: { entitlement: 200, percent_remaining: 75.4, unlimited: false },
      completions: { entitlement: 2000, percent_remaining: 100, unlimited: true },
      premium_interactions: { entitlement: 0, percent_remaining: 0, unlimited: false }
    }
  });
  assert.deepEqual(windows, [{
    kind: 'monthly',
    label: 'Chat',
    windowMinutes: 30 * 24 * 60,
    usedPct: 25,
    resetsAt: '2026-11-01T00:00:00Z'
  }]);
  assert.equal(copilot.planLabel({ access_type_sku: 'free_limited_copilot', copilot_plan: 'individual' }), 'Free');
  assert.equal(copilot.planLabel({ access_type_sku: 'monthly_subscriber', copilot_plan: 'individual' }), 'Individual');
});

test('Codex: janela curta é sessão, longa é semanal; reset como instante ou como prazo', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.deepEqual(codex.toWindow({ used_percent: 42.6, limit_window_seconds: 18000, reset_at: 1791900000 }, now), {
    kind: 'session',
    label: '5h',
    windowMinutes: 300,
    usedPct: 43,
    resetsAt: new Date(1791900000 * 1000).toISOString().replace('.000Z', 'Z')
  });
  const weekly = codex.toWindow({ used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 3600 }, now);
  assert.deepEqual([weekly.kind, weekly.label, weekly.windowMinutes, weekly.resetsAt], ['weekly', 'Semana', 10080, '2026-10-13T13:00:00Z']);
  assert.equal(codex.toWindow(null, now), null);
  assert.equal(codex.toWindow({ limit_window_seconds: 18000 }, now), null);
});

test('Cursor: cookie de sessão e id WorkOS a partir do JWT', () => {
  const token = fakeJwt('auth0|user_ABC');
  assert.equal(cursor.workosUserId(token), 'user_ABC');
  assert.equal(cursor.sessionCookie(token), `WorkosCursorSessionToken=user_ABC%3A%3A${token}`);
  assert.equal(cursor.workosUserId('nao-e-jwt'), null);
  assert.equal(cursor.sessionCookie('nao-e-jwt'), null);
});

test('Cursor: ciclo mensal, ilimitado, on-demand e pool semanal em epoch ms', () => {
  assert.deepEqual(cursor.mapWindows({
    isUnlimited: false,
    billingCycleStart: '2026-10-01T00:00:00.000Z',
    billingCycleEnd: '2026-11-01T00:00:00.000Z',
    individualUsage: { plan: { enabled: true, totalPercentUsed: 37.4 } }
  }), [{
    kind: 'monthly',
    label: 'Plano',
    windowMinutes: 31 * 24 * 60,
    usedPct: 37,
    resetsAt: '2026-11-01T00:00:00Z'
  }]);
  assert.equal(cursor.mapWindows({
    isUnlimited: true,
    billingCycleEnd: '2026-11-01T00:00:00Z'
  })[0].usedPct, 0);
  assert.deepEqual(cursor.mapWindows({
    billingCycleStart: '2026-10-13T00:00:00Z',
    billingCycleEnd: '2026-10-20T00:00:00Z',
    individualUsage: {
      plan: { enabled: true, totalPercentUsed: 10 },
      onDemand: { enabled: true, used: 25, limit: 100 }
    }
  }).map((w) => [w.kind, w.label, w.usedPct]), [['weekly', 'Semana', 10], ['weekly', 'Extra', 25]]);
  // Resposta do DashboardService (Premium): epoch em ms + planUsage no topo.
  const weekly = cursor.mapWindows(cursor.normalizeCursorUsage({
    billingCycleStart: '1792084777248',
    billingCycleEnd: '1792689577248',
    planUsage: { totalPercentUsed: 8.277, autoPercentUsed: 8.277, apiPercentUsed: 0 }
  }));
  assert.equal(weekly[0].kind, 'weekly');
  assert.equal(weekly[0].label, 'Semana');
  assert.equal(weekly[0].usedPct, 8);
  assert.equal(cursor.planLabel('premium'), 'Premium');
  assert.equal(cursor.planLabel(''), null);
});

test('Cursor: descobre CLI e perfis IDE; deduplica a mesma conta', async (t) => {
  const config = await tempDir(t);
  const tokenA = fakeJwt('google-oauth2|user_AAAA');
  const tokenB = fakeJwt('google-oauth2|user_BBBB');

  await fs.mkdir(path.join(config, 'cursor'), { recursive: true });
  await fs.writeFile(path.join(config, 'cursor', 'auth.json'), JSON.stringify({ accessToken: tokenA }));

  // Só a CLI.
  let accounts = await cursor.discoverCursorAccounts(config);
  assert.deepEqual(accounts.map((a) => [a.id, a.label, a.name]), [['cursor-cli', 'CUR', 'Cursor']]);

  // Mesmo usuário no IDE: fica só o IDE.
  const ideDb = path.join(config, 'Cursor', 'User', 'globalStorage');
  await fs.mkdir(ideDb, { recursive: true });
  await seedCursorDb(path.join(ideDb, 'state.vscdb'), tokenA);
  accounts = await cursor.discoverCursorAccounts(config);
  assert.deepEqual(accounts.map((a) => [a.id, a.label, a.name]), [['cursor-ide', 'CUR', 'Cursor']]);

  // Conta diferente na CLI: as duas aparecem.
  await fs.writeFile(path.join(config, 'cursor', 'auth.json'), JSON.stringify({ accessToken: tokenB }));
  accounts = await cursor.discoverCursorAccounts(config);
  assert.deepEqual(accounts.map((a) => [a.id, a.label, a.name]), [
    ['cursor-ide', 'CUR', 'Cursor (IDE)'],
    ['cursor-cli', 'CUR2', 'Cursor (CLI)']
  ]);
});

async function seedCursorDb(dbPath, accessToken) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('python3', ['-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)")
con.execute("INSERT INTO ItemTable VALUES (?, ?)", ("cursorAuth/accessToken", sys.argv[2]))
con.execute("INSERT INTO ItemTable VALUES (?, ?)", ("cursorAuth/stripeMembershipType", "premium"))
con.commit()
`, dbPath, accessToken]);
}

test('em inglês, os rótulos e nomes gerados pelo coletor mudam', async (t) => {
  setLanguage('en');
  assert.equal(claude.mapWindows({ seven_day: { utilization: 1 } })[0].label, 'Week');
  assert.equal(codex.toWindow({ used_percent: 5, limit_window_seconds: 604800 }, 0).label, 'Week');
  assert.equal(cursor.mapWindows({
    billingCycleEnd: '2026-11-01T00:00:00Z',
    individualUsage: { plan: { enabled: true, totalPercentUsed: 1 } }
  })[0].label, 'Plan');
  const quota = { entitlement: 10, percent_remaining: 50, unlimited: false };
  assert.deepEqual(copilot.mapWindows({ quota_snapshots: { completions: quota } }).map((w) => w.label), ['Code']);
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, '.claude-x', 'projects'), { recursive: true });
  assert.equal((await claude.discoverClaudeAccounts(home))[0].name, 'Claude (main)');
});
