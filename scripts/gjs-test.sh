#!/usr/bin/env bash
# Testes do coletor em GJS: a camada de plataforma contra um servidor local de
# mentira, e a paridade com o coletor em Node.
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for tool in gjs node; do
  command -v "$tool" >/dev/null || { echo "erro: $tool não encontrado" >&2; exit 2; }
done
WORK="$(mktemp -d)"
PORT_FILE="$WORK/port"
node --input-type=module - "$PORT_FILE" <<'NODE' &
import http from 'node:http';
import fs from 'node:fs';
const server = http.createServer((request, response) => {
  if (request.url === '/ok') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, header: request.headers['x-teste'] })); }
  else if (request.url === '/limit') { response.writeHead(429, { 'retry-after': '120' }); response.end('{}'); }
  else if (request.url === '/fail') { response.writeHead(500); response.end(); }
  else if (request.url === '/echo') { let body = ''; request.on('data', (c) => { body += c; }); request.on('end', () => { response.writeHead(200); response.end(body); }); }
  else if (request.url === '/redirect') { response.writeHead(302, { location: '/ok' }); response.end(); }
  else if (request.url === '/slow') { setTimeout(() => { response.writeHead(200); response.end('tarde'); }, 4000); }
  else { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(server.address().port)));
setTimeout(() => process.exit(0), 60000);
NODE
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 50); do [[ -s "$PORT_FILE" ]] && break; sleep 0.1; done
mkdir -p "$WORK/files"
gjs -m "$SRC/tests/gjs/platform-test.js" "$(cat "$PORT_FILE")" "$WORK/files"
PLATFORM=$?
echo
"$SRC/scripts/parity-test.sh"
PARITY=$?
exit $((PLATFORM + PARITY))
