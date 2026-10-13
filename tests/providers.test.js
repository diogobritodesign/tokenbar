import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import * as antigravity from '../collector/src/providers/antigravity.js';
import * as claude from '../collector/src/providers/claude.js';
import * as codex from '../collector/src/providers/codex.js';
import * as copilot from '../collector/src/providers/copilot.js';
import { setLanguage } from '../collector/src/i18n.js';
import { tempDir } from './helpers.js';

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
  assert.deepEqual(windows, [{ kind: 'monthly', label: 'Chat', usedPct: 25, resetsAt: '2026-11-01T00:00:00Z' }]);
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

test('em inglês, os rótulos e nomes gerados pelo coletor mudam', async (t) => {
  setLanguage('en');
  assert.equal(claude.mapWindows({ seven_day: { utilization: 1 } })[0].label, 'Week');
  assert.equal(codex.toWindow({ used_percent: 5, limit_window_seconds: 604800 }, 0).label, 'Week');
  const quota = { entitlement: 10, percent_remaining: 50, unlimited: false };
  assert.deepEqual(copilot.mapWindows({ quota_snapshots: { completions: quota } }).map((w) => w.label), ['Code']);
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, '.claude-x', 'projects'), { recursive: true });
  assert.equal((await claude.discoverClaudeAccounts(home))[0].name, 'Claude (main)');
});
