#!/usr/bin/env bash
# Abre um GNOME Shell aninhado (numa janela) com o código atual da extensão,
# para ver mudanças sem encerrar a sessão. Usa uma cópia das configurações em
# pasta temporária; os dados vêm do seu ~/.cache/tokenbar/state.json real, ou
# de dados de demonstração com --demo.
#
#   scripts/preview.sh [--demo]
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="tokenbar@tokenbar"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT

mkdir -p "$WORK/data/gnome-shell/extensions" "$WORK/data/fonts" "$WORK/config" "$WORK/cache/tokenbar"
cp -r "$SRC/extension/$UUID" "$WORK/data/gnome-shell/extensions/"
glib-compile-schemas --strict "$WORK/data/gnome-shell/extensions/$UUID/schemas"
cp "$SRC"/fonts/*.ttf "$WORK/data/fonts/"

REAL_STATE="${XDG_CACHE_HOME:-$HOME/.cache}/tokenbar/state.json"
if [[ "${1:-}" == "--demo" || ! -f "$REAL_STATE" ]]; then
  node "$SRC/scripts/demo-state.mjs" "$WORK/cache/tokenbar/state.json"
else
  cp "$REAL_STATE" "$WORK/cache/tokenbar/state.json"
fi

# GNOME 49+ usa --devkit; versões anteriores, --nested.
MODE="--devkit"
gnome-shell --help 2>/dev/null | grep -q -- '--devkit' || MODE="--nested"

XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
  dbus-run-session -- bash -c "
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions \"['$UUID']\"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version '99'
    exec gnome-shell $MODE --wayland
  "
