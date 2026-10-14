import assert from 'node:assert/strict';
import test from 'node:test';
import { levelOf, polybarOutput, waybarOutput } from '../collector/src/bar.js';

const state = {
  providers: [
    { id: 'claude-main', label: 'CLD', name: 'Claude', status: 'ok', windows: [{ usedPct: 38 }, { usedPct: 12 }], error: null },
    { id: 'claude-2', label: 'CLD2', name: 'Claude (work)', status: 'ok', windows: [{ usedPct: 88 }], error: null },
    { id: 'codex', label: 'OAI', name: 'Codex', status: 'unauthorized', windows: [], error: 'login expired' },
    { id: 'antigravity', label: 'AG', name: 'Antigravity', status: 'idle', windows: [{ usedPct: 65 }], error: 'closed' }
  ]
};

test('nível pelo maior uso, com os mesmos limites da extensão', () => {
  assert.equal(levelOf(state.providers[0]), 'ok');
  assert.equal(levelOf(state.providers[1]), 'crit');
  assert.equal(levelOf(state.providers[2]), 'off');
  assert.equal(levelOf(state.providers[3]), 'warn', 'ferramenta fechada mantém a cor do último valor');
  assert.equal(levelOf(state.providers[1], { warn: 90, crit: 95 }), 'ok');
});

test('Waybar: texto com o restante, dica com as contas e classe da mais crítica', () => {
  assert.deepEqual(waybarOutput(state), {
    text: 'CLD 62%  CLD2 12%  AG 35%',
    tooltip: 'Claude: 62%\nClaude (work): 12%\nAntigravity: 35% — closed',
    class: 'crit',
    percentage: 88
  });
  assert.equal(waybarOutput(state, { showRemaining: false }).text, 'CLD 38%  CLD2 88%  AG 65%');
});

test('Polybar: cores por nível, ou texto puro', () => {
  assert.equal(polybarOutput(state), '%{F#7bea83}●%{F-} CLD 62%  %{F#ff7b72}●%{F-} CLD2 12%  %{F#ece38f}●%{F-} AG 35%');
  assert.equal(polybarOutput(state, { colors: false }), 'CLD 62%  CLD2 12%  AG 35%');
});

test('sem estado ou sem dados: saída neutra, sem quebrar', () => {
  assert.deepEqual(waybarOutput(null), { text: 'TokenBar —', tooltip: 'TokenBar: no data', class: 'off', percentage: 0 });
  assert.equal(polybarOutput({ providers: [state.providers[2]] }), 'TokenBar —');
});
