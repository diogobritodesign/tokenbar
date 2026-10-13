import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY, formatAge, formatAmount, formatDuration, formatReset, formatTokens, paceOf, projectedExhaustion,
  windowsOf, worstPct
} from '../extension/tokenbar@tokenbar/lib/format.js';
import { resolveLanguage, setLanguage } from '../extension/tokenbar@tokenbar/lib/i18n.js';

// Os textos abaixo são os de português; o inglês tem um teste próprio no fim.
test.beforeEach(() => setLanguage('pt'));

const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-13T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('tokens em k, M e B com vírgula decimal', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(12340), '12,3k');
  assert.equal(formatTokens(1834000), '1,8M');
  assert.equal(formatTokens(4.02e9), '4B');
  assert.equal(formatTokens(null), EMPTY);
  assert.equal(formatTokens(NaN), EMPTY);
});

test('valores em dinheiro no formato brasileiro', () => {
  assert.equal(formatAmount(0), '0,00');
  assert.equal(formatAmount(72.154), '72,15');
  assert.equal(formatAmount(6761.3), '6.761,30');
  assert.equal(formatAmount(1234567.891), '1.234.567,89');
});

test('durações e tempo até o reset', () => {
  assert.equal(formatDuration(14 * MIN), '14min');
  assert.equal(formatDuration(2 * HOUR + 14 * MIN), '2h 14min');
  assert.equal(formatDuration(3 * 24 * HOUR + 4 * HOUR), '3d 4h');
  assert.equal(formatReset(iso(NOW + 2 * HOUR + 14 * MIN), NOW), 'reseta em 2h 14min');
  assert.equal(formatReset(iso(NOW - MIN), NOW), 'reseta em instantes');
  assert.equal(formatReset(null, NOW), '');
  assert.equal(formatReset('lixo', NOW), '');
});

test('idade da última atualização', () => {
  assert.equal(formatAge(40000), 'atualizado há 40 s');
  assert.equal(formatAge(3 * MIN + 5000), 'atualizado há 3 min');
  assert.equal(formatAge(2 * HOUR), 'atualizado há 2 h');
  assert.equal(formatAge(-5), 'atualizado há 0 s');
});

test('a janela mais restritiva é a de maior uso; entradas inválidas são ignoradas', () => {
  const provider = { windows: [{ usedPct: 17 }, null, { usedPct: 'x' }, { usedPct: 42 }] };
  assert.equal(windowsOf(provider).length, 2);
  assert.equal(worstPct(provider), 42);
  assert.equal(worstPct({ windows: [] }), null);
  assert.equal(worstPct({}), null);
});

test('projeção pela média da janela: só quando o limite acabaria antes do reset', () => {
  // Janela de 5 h, faltam 2 h: 3 h decorridas com 70% -> 100% em ~1h17
  const fast = { kind: 'session', windowMinutes: 300, usedPct: 70, resetsAt: iso(NOW + 2 * HOUR) };
  assert.equal(Math.round((projectedExhaustion(fast, NOW) - NOW) / MIN), 77);
  // Mesmo tempo com 40%: chegaria a 100% só depois do reset
  assert.equal(projectedExhaustion({ ...fast, usedPct: 40 }, NOW), null);
  // Pouco uso ou janela recém-aberta: sem base para projetar
  assert.equal(projectedExhaustion({ ...fast, usedPct: 3 }, NOW), null);
  assert.equal(projectedExhaustion({ ...fast, usedPct: 30, resetsAt: iso(NOW + 295 * MIN) }, NOW), null);
  assert.equal(projectedExhaustion({ ...fast, resetsAt: null }, NOW), null);
  // Sem windowMinutes, a duração vem do tipo da janela
  assert.ok(projectedExhaustion({ kind: 'session', usedPct: 70, resetsAt: iso(NOW + 2 * HOUR) }, NOW) > NOW);
  assert.equal(projectedExhaustion({ kind: 'monthly', usedPct: 70, resetsAt: iso(NOW + 2 * HOUR) }, NOW), null);
});

test('linha de ritmo: prefere o ritmo recente do coletor e trata os extremos', () => {
  const window = { kind: 'session', windowMinutes: 300, usedPct: 70, resetsAt: iso(NOW + 2 * HOUR) };
  assert.equal(paceOf(window, 'warn', NOW).text, 'esgota em ~1h 17min');
  assert.equal(paceOf({ ...window, pace: { basis: 'recent', exhaustsAt: iso(NOW + 25 * MIN) } }, 'warn', NOW).text, 'esgota em ~25min');
  // O coletor mediu e concluiu que não esgota: não cai de volta na média
  assert.equal(paceOf({ ...window, pace: { basis: 'recent', exhaustsAt: null } }, 'warn', NOW), null);
  assert.deepEqual(paceOf({ ...window, usedPct: 100 }, 'crit', NOW), { text: 'limite atingido', styleClass: 'tokenbar-pace-crit' });
  assert.equal(paceOf(window, 'off', NOW), null);
});

test('em inglês: textos, separadores de número e escolha automática do idioma', () => {
  setLanguage('en');
  assert.equal(formatTokens(1834000), '1.8M');
  assert.equal(formatTokens(12340), '12.3k');
  assert.equal(formatAmount(6761.3), '6,761.30');
  assert.equal(formatReset(iso(NOW + 2 * HOUR + 14 * MIN), NOW), 'resets in 2h 14min');
  assert.equal(formatAge(40000), 'updated 40 s ago');
  assert.equal(paceOf({ kind: 'session', windowMinutes: 300, usedPct: 100, resetsAt: iso(NOW + HOUR) }, 'crit', NOW).text, 'limit reached');

  assert.equal(resolveLanguage('auto', ['pt_BR.UTF-8', 'pt_BR', 'pt', 'C']), 'pt');
  assert.equal(resolveLanguage('auto', ['en_US.UTF-8', 'en']), 'en');
  assert.equal(resolveLanguage('auto', ['de_DE.UTF-8']), 'en');
  assert.equal(resolveLanguage('auto', []), 'en');
  assert.equal(resolveLanguage('en', ['pt_BR']), 'en');
  assert.equal(resolveLanguage('pt', ['en_US']), 'pt');
});
