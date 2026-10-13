import assert from 'node:assert/strict';
import test from 'node:test';
import * as collector from '../collector/src/i18n.js';
import * as extension from '../extension/tokenbar@tokenbar/lib/i18n.js';

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

for (const [name, table] of [['extensão', extension.STRINGS], ['coletor', collector.MESSAGES]]) {
  test(`${name}: toda chave tem português e inglês, com os mesmos marcadores`, () => {
    for (const [key, entry] of Object.entries(table)) {
      assert.equal(entry.length, 2, key);
      for (const text of entry) assert.ok(typeof text === 'string' && text.trim() !== '', `${key} vazio`);
      assert.deepEqual(placeholders(entry[0]), placeholders(entry[1]), `${key}: marcadores diferentes`);
    }
  });
}

test('extensão: troca de idioma, marcadores e chave inexistente', () => {
  extension.setLanguage('pt');
  assert.equal(extension.t('reset.in', { time: '2h' }), 'reseta em 2h');
  extension.setLanguage('en');
  assert.equal(extension.t('reset.in', { time: '2h' }), 'resets in 2h');
  extension.setLanguage('xx');
  assert.equal(extension.getLanguage(), 'en');
  assert.equal(extension.t('chave.que.nao.existe'), 'chave.que.nao.existe');
});

test('coletor: idioma do sistema pelas variáveis de ambiente', () => {
  assert.equal(collector.systemLanguage({ LANG: 'pt_BR.UTF-8' }), 'pt');
  assert.equal(collector.systemLanguage({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(collector.systemLanguage({ LANG: 'pt_BR.UTF-8', LC_ALL: 'C' }), 'en');
  assert.equal(collector.systemLanguage({}), 'en');
  collector.setLanguage('en');
  assert.equal(collector.t('net.denied', { status: 403 }), 'access denied (HTTP 403)');
  collector.setLanguage('pt');
  assert.equal(collector.t('net.denied', { status: 403 }), 'acesso negado (HTTP 403)');
});

test('toda chave usada no código existe na tabela', async () => {
  const fs = await import('node:fs/promises');
  const used = async (files, pattern) => {
    const keys = new Set();
    for (const file of files) {
      for (const match of (await fs.readFile(file, 'utf8')).matchAll(pattern)) keys.add(match[1]);
    }
    return [...keys];
  };
  const ext = 'extension/tokenbar@tokenbar/';
  const extKeys = [
    ...(await used([`${ext}extension.js`, `${ext}indicator.js`, `${ext}prefs.js`, `${ext}lib/format.js`], /\bt\('([a-zA-Z0-9.]+)'/g)),
    // Listas de opções: [valor gravado, chave do texto]
    ...(await used([`${ext}providers.js`], /^\s+\['[a-z0-9]+', '([a-zA-Z0-9.]+)'\],$/gm)),
    ...(await used([`${ext}indicator.js`], /^\s+\['[a-z0-9]+', '([a-zA-Z0-9.]+)', \d+\],$/gm))
  ];
  assert.ok(extKeys.length > 80, `só ${extKeys.length} chaves encontradas`);
  for (const key of extKeys) {
    assert.ok(key in extension.STRINGS, `extensão usa "${key}", que não está na tabela`);
  }
  const col = 'collector/';
  const colKeys = await used(
    [`${col}bin/tokenbar-collector.js`, `${col}src/collect.js`, `${col}src/http.js`, `${col}src/providers/claude.js`,
      `${col}src/providers/codex.js`, `${col}src/providers/copilot.js`, `${col}src/providers/antigravity.js`],
    /\bt\('([a-zA-Z.]+)'/g
  );
  assert.ok(colKeys.length > 20);
  for (const key of colKeys) assert.ok(key in collector.MESSAGES, `coletor usa "${key}", que não está na tabela`);
});
