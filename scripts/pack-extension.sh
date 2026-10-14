#!/usr/bin/env bash
# Monta o pacote da extensão para o extensions.gnome.org: a extensão com o
# coletor em GJS dentro dela (sem Node e sem systemd).
#
#   scripts/pack-extension.sh [PASTA_DE_SAÍDA]   (padrão: dist/)
# Também deixa a pasta montada em PASTA_DE_SAÍDA/tokenbar@tokenbar, usada pelos testes.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:-$SRC/dist}" && cd "${1:-$SRC/dist}" && pwd)"
UUID="tokenbar@tokenbar"
STAGE="$OUT/$UUID"

rm -rf "$STAGE" "$OUT/$UUID.shell-extension.zip"
cp -r "$SRC/extension/$UUID" "$STAGE"
rm -f "$STAGE/schemas/gschemas.compiled"
mkdir -p "$STAGE/collector"
cp -r "$SRC/collector/src" "$SRC/collector/gjs" "$STAGE/collector/"
# O coletor em Node não vai no pacote: só a plataforma e o código comum.
rm -f "$STAGE/collector/src/platform/node.js"
cp "$SRC/LICENSE" "$STAGE/"

( cd "$STAGE" && zip -qr "$OUT/$UUID.shell-extension.zip" . )
echo "$OUT/$UUID.shell-extension.zip"
