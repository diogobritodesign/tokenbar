import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAccountNames, normalizeAccountNames } from '../collector/src/names.js';

test('nomes personalizados: limpa, limita e põe a sigla em maiúsculas', () => {
  assert.deepEqual(
    normalizeAccountNames({
      'claude-main': { name: '  Trabalho   pessoal ', label: 'wk' },
      'claude-2': { name: '', label: '' },
      codex: { label: 'chatgpt' },
      ruim: 'texto',
      outro: null
    }),
    { 'claude-main': { name: 'Trabalho pessoal', label: 'WK' }, codex: { label: 'CHATG' } }
  );
  assert.deepEqual(normalizeAccountNames(null), {});
  assert.deepEqual(normalizeAccountNames(['x']), {});
});

test('nomes personalizados: aplica por id e guarda o padrão para voltar', () => {
  const items = [
    { id: 'claude-main', label: 'CLD', name: 'Claude 1' },
    { id: 'claude-2', label: 'CLD2', name: 'Claude 2' }
  ];
  const named = applyAccountNames(items, { 'claude-2': { name: 'Freela' } });
  assert.deepEqual(named.map((a) => [a.name, a.label, a.defaultName, a.defaultLabel]), [
    ['Claude 1', 'CLD', 'Claude 1', 'CLD'],
    ['Freela', 'CLD2', 'Claude 2', 'CLD2']
  ]);
  // Aplicar de novo (ex.: sobre o state.json) não perde o padrão.
  assert.equal(applyAccountNames(named, {})[1].name, 'Claude 2');
});
