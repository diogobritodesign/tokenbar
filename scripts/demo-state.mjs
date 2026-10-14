#!/usr/bin/env node
// Gera um state.json de demonstração (dados inventados) para capturas de tela
// e para o teste de interface. Uso: node scripts/demo-state.mjs ARQUIVO [pt|en]
import fs from 'node:fs/promises';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('uso: node scripts/demo-state.mjs ARQUIVO [pt|en]');
  process.exit(2);
}

const en = process.argv[3] === 'en';
const WEEK = en ? 'Week' : 'Semana';
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const dayKey = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const window = (kind, label, usedPct, resetIn, extra = {}) => ({
  kind,
  label,
  windowMinutes: kind === 'session' ? 300 : kind === 'monthly' ? undefined : 10080,
  usedPct,
  resetsAt: resetIn === null ? null : iso(now + resetIn),
  ...extra
});

// Série de 30 dias com cara de uso real: dias fortes, fracos e alguns vazios.
const shape = [0, 0, 3, 9, 14, 11, 4, 12, 5, 1, 0, 7, 2, 9, 8, 1, 4, 3, 10, 13, 5, 2, 0, 6, 11, 4, 8, 12, 6, 3];
const series = shape.map((weight, index) => ({
  day: dayKey(now - (shape.length - 1 - index) * DAY),
  tokens: weight * 31_000_000,
  costUsd: Math.round(weight * 9.4 * 100) / 100
}));
const sum = (days, key) => series.slice(-days).reduce((total, day) => total + day[key], 0);

const state = {
  version: 1,
  updatedAt: iso(now - 40e3),
  fx: { usdBrl: 5.02, asOf: iso(now - 3 * HOUR) },
  services: [{ id: 'claude', name: 'Claude', indicator: 'none', description: 'All Systems Operational' }],
  update: process.argv.includes('--update') ? {
    installed: 'a1b2c3d', version: '0.1.0', available: true, latest: 'e4f5a6b', latestDate: iso(now - 3 * HOUR),
    summary: en ? 'Add Gemini CLI support' : 'Suporte ao Gemini CLI', url: 'https://github.com/diogobritodesign/tokenbar/compare/a1b2c3d...e4f5a6b'
  } : null,
  accounts: [
    { id: 'claude-main', label: 'CLD', name: en ? 'Claude (main)' : 'Claude (principal)', enabled: true },
    { id: 'claude-2', label: 'CLD2', name: en ? 'Claude (work)' : 'Claude (trabalho)', enabled: true },
    { id: 'codex', label: 'OAI', name: 'Codex / ChatGPT', enabled: true },
    { id: 'antigravity', label: 'AG', name: 'Antigravity', enabled: true },
    { id: 'copilot', label: 'GH', name: 'GitHub Copilot', enabled: true }
  ],
  usage: {
    series,
    last7: { tokens: sum(7, 'tokens'), costUsd: Math.round(sum(7, 'costUsd') * 100) / 100 },
    last30: { tokens: sum(30, 'tokens'), costUsd: Math.round(sum(30, 'costUsd') * 100) / 100 },
    complete: true
  },
  providers: [
    {
      id: 'claude-main', label: 'CLD', name: en ? 'Claude (main)' : 'Claude (principal)', plan: 'Max 5x', status: 'ok',
      windows: [
        window('session', '5h', 38, 2.6 * HOUR, { pace: { basis: 'recent', exhaustsAt: null } }),
        window('weekly', WEEK, 12, 5.9 * DAY)
      ],
      tokensToday: 84_300_000, costTodayUsd: 24.6, costPartial: false,
      tokensBreakdown: { input: 6_200, output: 612_000, cacheWrite: 1_480_000, cacheRead: 82_201_800 },
      modelsToday: [
        { model: 'claude-opus-5-5', tokens: 71_900_000, costUsd: 23.1 },
        { model: 'claude-haiku-5-5', tokens: 12_400_000, costUsd: 1.5 }
      ],
      sessionsToday: [
        { project: en ? 'online-store' : 'loja-online', path: null, tokens: 52_100_000, costUsd: 15.8, lastAt: iso(now - 600e3) },
        { project: en ? 'payments-api' : 'api-pagamentos', path: null, tokens: 24_000_000, costUsd: 6.9, lastAt: iso(now - 4 * HOUR) },
        { project: 'dotfiles', path: null, tokens: 8_200_000, costUsd: 1.9, lastAt: iso(now - 7 * HOUR) }
      ],
      error: null
    },
    {
      id: 'claude-2', label: 'CLD2', name: en ? 'Claude (work)' : 'Claude (trabalho)', plan: 'Pro', status: 'ok',
      windows: [
        window('session', '5h', 72, 1.4 * HOUR, { pace: { basis: 'recent', exhaustsAt: iso(now + 0.6 * HOUR) } }),
        window('weekly', WEEK, 88, 2.2 * DAY)
      ],
      tokensToday: 9_640_000, costTodayUsd: 3.42, costPartial: false,
      tokensBreakdown: { input: 900, output: 88_000, cacheWrite: 240_000, cacheRead: 9_311_100 },
      modelsToday: [{ model: 'claude-sonnet-5-5', tokens: 9_640_000, costUsd: 3.42 }],
      sessionsToday: [{ project: en ? 'reports' : 'relatorios', path: null, tokens: 9_640_000, costUsd: 3.42, lastAt: iso(now - 900e3) }],
      error: null
    },
    {
      id: 'codex', label: 'OAI', name: 'Codex / ChatGPT', plan: 'Plus', status: 'ok',
      windows: [window('session', '5h', 21, 3.3 * HOUR), window('weekly', WEEK, 47, 4.1 * DAY)],
      tokensToday: null, costTodayUsd: null, costPartial: false, tokensBreakdown: null,
      modelsToday: [], sessionsToday: [], error: null
    },
    {
      id: 'antigravity', label: 'AG', name: 'Antigravity', plan: 'Pro', status: 'idle',
      windows: [
        window('session', '5h', 9, 4.1 * HOUR, { group: 'Gemini' }),
        window('weekly', WEEK, 31, 6.2 * DAY, { group: 'Gemini' }),
        window('session', '5h', 100, 1.1 * HOUR, { group: 'Claude/GPT' }),
        window('weekly', WEEK, 64, 6.8 * DAY, { group: 'Claude/GPT' })
      ],
      tokensToday: null, costTodayUsd: null, costPartial: false, tokensBreakdown: null,
      modelsToday: [], sessionsToday: [], error: en ? 'Antigravity is closed — showing the last known value' : 'Antigravity fechado — mostrando o último valor'
    },
    {
      id: 'copilot', label: 'GH', name: 'GitHub Copilot', plan: 'Free', status: 'ok',
      windows: [window('monthly', 'Chat', 15, 18 * DAY), window('monthly', en ? 'Code' : 'Código', 4, 18 * DAY)],
      tokensToday: null, costTodayUsd: null, costPartial: false, tokensBreakdown: null,
      modelsToday: [], sessionsToday: [], error: null
    }
  ]
};

await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
await fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`);
