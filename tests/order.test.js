import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProviderOrder, mergeProviderOrder, moveInOrder } from '../collector/src/order.js';

test('aplica a ordem gravada e deixa ids novos no fim', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(applyProviderOrder(items, ['c', 'a']).map((i) => i.id), ['c', 'a', 'b']);
  assert.deepEqual(applyProviderOrder(items, []).map((i) => i.id), ['a', 'b', 'c']);
});

test('merge preenche ids novos e remove os que sumiram', () => {
  assert.deepEqual(mergeProviderOrder(['z', 'a', 'b'], ['b', 'a', 'c']), ['a', 'b', 'c']);
});

test('move sobe e desce sem sair dos limites', () => {
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});
