#!/usr/bin/env bash
# Confere que o coletor em GJS (embutido na extensão) e o em Node (serviço do
# systemd) produzem o mesmo state.json a partir dos mesmos dados: uma pasta
# pessoal de mentira com contas, conversas de hoje e de dias anteriores.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for tool in node gjs; do
  command -v "$tool" >/dev/null || { echo "erro: $tool não encontrado" >&2; exit 2; }
done
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

node --input-type=module - "$WORK/home" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';
const home = process.argv[2];
const now = Date.now();
const line = (id, at, usage, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: new Date(at).toISOString(), sessionId: extra.session ?? 's1', cwd: extra.cwd ?? '/home/u/alpha',
  message: { id, model: extra.model ?? 'claude-opus-5-5', usage }
});
const usage = (input, output, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 } });
async function account(dir, lines) {
  await fs.mkdir(path.join(dir, 'projects', 'p', 's1', 'subagents'), { recursive: true });
  // Login vencido: nenhum dos dois coletores chama a API, então o resultado não depende da rede.
  await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: now - 1000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }));
  await fs.writeFile(path.join(dir, 'projects', 'p', 'a.jsonl'), lines.main.join('\n') + '\n{"type":"assist');
  await fs.writeFile(path.join(dir, 'projects', 'p', 's1', 'subagents', 'b.jsonl'), lines.sub.join('\n') + '\n');
}
const today = now - 60_000;
await account(path.join(home, '.claude'), {
  main: [line('m1', today, usage(100, 2000, 50000, 3000)), line('m1', today, usage(100, 2500, 50000, 3000)), 'not json', line('m2', today, usage(10, 20), { model: 'modelo-sem-preco' }), line('old', now - 3 * 86400e3, usage(1, 1e6))],
  sub: [line('m3', today, usage(5, 700, 0, 0), { session: 's1' }), line('m4', today, usage(1, 1), { session: 's2', cwd: '/home/u/beta' })]
});
await account(path.join(home, '.claude-trabalho'), { main: [line('w1', today, usage(0, 1e6))], sub: [] });
await fs.mkdir(path.join(home, '.config', 'tokenbar'), { recursive: true });
NODE

run() {  # run NOME comando...
  local name="$1"; shift
  mkdir -p "$WORK/$name"
  HOME="$WORK/home" LANG=pt_BR.UTF-8 XDG_CACHE_HOME="$WORK/$name/cache" XDG_STATE_HOME="$WORK/$name/state" \
    XDG_CONFIG_HOME="$WORK/home/.config" "$@" --once 2>"$WORK/$name/stderr" >/dev/null
  echo $?
}
NODE_EXIT="$(run node node "$SRC/collector/bin/tokenbar-collector.js")"
GJS_EXIT="$(run gjs gjs -m "$SRC/collector/gjs/tokenbar-collector.js")"

node --input-type=module - "$WORK" "$NODE_EXIT" "$GJS_EXIT" <<'NODE'
import fs from 'node:fs';
const [work, nodeExit, gjsExit] = process.argv.slice(2);
let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok   ' : 'FALHA'} ${label}${ok ? '' : ` ${detail}`}`);
  if (!ok) fails += 1;
};
const read = (name, file) => JSON.parse(fs.readFileSync(`${work}/${name}/${file}`, 'utf8'));
// Campos que mudam a cada execução ou dependem da rede pública.
const strip = (state) => {
  const copy = structuredClone(state);
  delete copy.updatedAt; delete copy.fx; delete copy.services; delete copy.update;
  for (const provider of copy.providers) for (const session of provider.sessionsToday ?? []) delete session.lastAt;
  return copy;
};
console.log('Paridade Node × GJS');
check('os dois terminam sem erro', nodeExit === '0' && gjsExit === '0', `(node ${nodeExit}, gjs ${gjsExit}: ${fs.readFileSync(`${work}/gjs/stderr`, 'utf8').slice(0, 300)})`);
const node = read('node', 'cache/tokenbar/state.json');
const gjs = read('gjs', 'cache/tokenbar/state.json');
// Primeiro caminho em que os dois diferem, para a falha dizer onde.
const firstDifference = (a, b, at = '') => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference(a[key], b[key], `${at}.${key}`);
      if (found) return found;
    }
  }
  return `${at}: node=${JSON.stringify(a)?.slice(0, 160)} gjs=${JSON.stringify(b)?.slice(0, 160)}`;
};
const stateDiff = firstDifference(strip(node), strip(gjs));
check('mesmo state.json', !stateDiff, stateDiff ?? '');
// m1 (última versão) 55.600 + m2 30 (modelo sem preço) + m3 705 do subagente + m4 2; "old" é de outro dia.
check('o resultado tem o que se espera', node.providers.length === 2 && node.providers[0].tokensToday === 56337 &&
  node.providers[0].costPartial === true && node.providers.every((p) => p.status === 'unauthorized'),
  JSON.stringify(node.providers.map((p) => [p.id, p.status, p.tokensToday])));
const cacheNode = read('node', 'cache/tokenbar/usage-cache.json');
const cacheGjs = read('gjs', 'cache/tokenbar/usage-cache.json');
// A ordem das chaves depende de qual conta termina primeiro (rodam em paralelo) e não tem significado.
const sorted = (value) => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const cacheDiff = firstDifference(sorted(cacheNode.files), sorted(cacheGjs.files));
check('mesmo cache de leitura incremental', !cacheDiff, cacheDiff ?? '');
check('mesmo histórico', JSON.stringify(read('node', 'state/tokenbar/history.json').days) === JSON.stringify(read('gjs', 'state/tokenbar/history.json').days));
console.log(fails === 0 ? '\nparidade: tudo igual' : `\nparidade: ${fails} diferença(s)`);
process.exit(fails);
NODE
