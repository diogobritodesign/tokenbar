import assert from 'node:assert/strict';
import test from 'node:test';
import { messageCostUsd } from '../collector/src/pricing.js';

const none = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('preço de entrada e saída por milhão de tokens', () => {
  near(messageCostUsd('claude-opus-5-5', { ...none, input: 1e6 }), 4);
  near(messageCostUsd('claude-opus-5-5', { ...none, output: 1e6 }), 20);
  near(messageCostUsd('claude-sonnet-5-5', { ...none, input: 1e6, output: 1e6 }), 12);
});

test('escrita de cache custa 1,25x (5 min) e 2x (1 h) a entrada; leitura tem preço próprio', () => {
  near(messageCostUsd('claude-opus-5-5', { ...none, cacheWrite5m: 1e6 }), 5);
  near(messageCostUsd('claude-opus-5-5', { ...none, cacheWrite1h: 1e6 }), 8);
  near(messageCostUsd('claude-opus-5-5', { ...none, cacheRead: 1e6 }), 0.2);
  near(messageCostUsd('claude-fable-5-1', { ...none, cacheRead: 1e6 }), 0.25);
});

test('o prefixo mais específico vence e sufixos de data são aceitos', () => {
  near(messageCostUsd('claude-opus-5', { ...none, input: 1e6 }), 5);
  near(messageCostUsd('claude-opus-5-5-20260101', { ...none, input: 1e6 }), 4);
  near(messageCostUsd('claude-haiku-4-5', { ...none, output: 1e6 }), 5);
});

test('modelo fora da tabela devolve null, não zero', () => {
  assert.equal(messageCostUsd('gpt-9', { ...none, input: 1e6 }), null);
  assert.equal(messageCostUsd('', { ...none, input: 1e6 }), null);
});
