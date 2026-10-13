#!/usr/bin/env bash
# Instala o coletor (serviço systemd --user) e a extensão GNOME do TokenBar.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="tokenbar@tokenbar"
APP_DIR="$HOME/.local/share/tokenbar"
BIN="$HOME/.local/bin/tokenbar-collector"
UNIT_DIR="$HOME/.config/systemd/user"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "error: node not found in PATH" >&2
  exit 1
fi
if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "error: Node.js 20 or newer is required (found: $("$NODE" --version))" >&2
  exit 1
fi
for tool in glib-compile-schemas systemctl gnome-extensions gsettings; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done
command -v ss >/dev/null || echo "warning: 'ss' (iproute2) not found; Antigravity will not be read"
command -v gh >/dev/null || echo "warning: 'gh' not found; GitHub Copilot will not be read"

echo "==> Collector"
mkdir -p "$APP_DIR" "$HOME/.local/bin" "$UNIT_DIR"
install -d -m 700 "$HOME/.cache/tokenbar"
rm -rf "$APP_DIR/collector"
cp -r "$SRC/collector" "$APP_DIR/collector"

# O caminho absoluto do node e o PATH deste terminal ficam gravados aqui porque
# o PATH do systemd --user costuma ser mais curto (nvm, fnm, ~/.local/bin), e
# o coletor precisa achar `gh` e `ss`.
cat > "$BIN" <<EOF
#!/bin/sh
PATH="$PATH"
export PATH
exec "$NODE" "$APP_DIR/collector/bin/tokenbar-collector.js" "\$@"
EOF
chmod 755 "$BIN"

install -m 644 "$SRC/systemd/tokenbar-collector.service" "$UNIT_DIR/tokenbar-collector.service"
systemctl --user daemon-reload
systemctl --user enable tokenbar-collector.service >/dev/null
systemctl --user restart tokenbar-collector.service

echo "==> Font"
FONT_DIR="$HOME/.local/share/fonts/tokenbar"
mkdir -p "$FONT_DIR" "$HOME/.config/tokenbar"
cp "$SRC"/fonts/*.ttf "$FONT_DIR/"
fc-cache -f "$FONT_DIR" 2>/dev/null || true

echo "==> Extension"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -r "$SRC/extension/$UUID/." "$EXT_DIR/"
glib-compile-schemas --strict "$EXT_DIR/schemas"

if gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "extension enabled"
else
  # O shell ainda não conhece a extensão recém-copiada; deixa marcada para
  # ser carregada no próximo login.
  current="$(gsettings get org.gnome.shell enabled-extensions)"
  if [[ "$current" != *"'$UUID'"* ]]; then
    if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
      gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
      gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
    fi
  fi
  echo "extension set to load at your next login"
fi

cat <<EOF

Done.
  * Collector:  systemctl --user status tokenbar-collector
  * State:      ~/.cache/tokenbar/state.json

IMPORTANT: on Wayland, GNOME Shell only loads a new extension (or new
extension code) when the session starts. Log out and back in.
EOF
