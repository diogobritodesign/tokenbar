#!/usr/bin/env bash
# Instala o coletor (serviço systemd --user) e, para mostrar os dados:
#   - no GNOME, a extensão da barra superior;
#   - em outros desktops (KDE, Xfce, Cinnamon, MATE, Budgie...), um ícone de bandeja.
#
#   ./install.sh          escolhe pelo desktop atual
#   ./install.sh --tray   instala também o ícone de bandeja (útil no GNOME com AppIndicator)
set -euo pipefail

WANT_TRAY=0
WANT_EXTENSION=0
case "${XDG_CURRENT_DESKTOP:-}" in
  *GNOME*) WANT_EXTENSION=1 ;;
  *) WANT_TRAY=1 ;;
esac
[[ " $* " == *" --tray "* ]] && WANT_TRAY=1

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
command -v systemctl >/dev/null || { echo "error: systemctl not found (systemd user services are required)" >&2; exit 1; }
if [[ $WANT_EXTENSION == 1 ]]; then
  for tool in glib-compile-schemas gnome-extensions gsettings; do
    command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
  done
fi
if [[ $WANT_TRAY == 1 ]] && ! python3 -c 'import gi; gi.require_version("Gio", "2.0")' 2>/dev/null; then
  echo "error: the tray icon needs Python 3 with PyGObject" >&2
  echo "       Fedora: sudo dnf install python3-gobject   Debian/Ubuntu: sudo apt install python3-gi" >&2
  echo "       Arch: sudo pacman -S python-gobject        openSUSE: sudo zypper install python3-gobject" >&2
  exit 1
fi
if [[ $WANT_TRAY == 1 ]] && ! python3 -c 'import gi; gi.require_version("Gtk", "4.0")' 2>/dev/null; then
  echo "warning: GTK 4 for Python not found; clicking the tray icon will show a plain menu instead of the panel"
fi
command -v ss >/dev/null || echo "warning: 'ss' (iproute2) not found; Antigravity will not be read"
command -v gh >/dev/null || echo "warning: 'gh' not found; GitHub Copilot will not be read"

echo "==> Collector"
mkdir -p "$APP_DIR" "$HOME/.local/bin" "$UNIT_DIR"
install -d -m 700 "$HOME/.cache/tokenbar"
rm -rf "$APP_DIR/collector"
cp -r "$SRC/collector" "$APP_DIR/collector"
# Qual versão foi instalada, para o aviso de atualização comparar com o GitHub.
COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)"
VERSION="$("$NODE" -p "require('$SRC/package.json').version")"
printf '{"version":"%s","commit":"%s","installedAt":"%s"}\n' "$VERSION" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$APP_DIR/collector/VERSION.json"

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

if [[ $WANT_EXTENSION == 1 ]]; then
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
fi

if [[ $WANT_TRAY == 1 ]]; then
  echo "==> Tray icon"
  rm -rf "$APP_DIR/tray"
  cp -r "$SRC/tray" "$APP_DIR/tray"
  ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
  mkdir -p "$ICON_DIR"
  install -m 644 "$SRC/assets/tokenbar-app-icon.svg" "$ICON_DIR/tokenbar.svg"
  AUTOSTART="$HOME/.config/autostart"
  mkdir -p "$AUTOSTART"
  cat > "$AUTOSTART/tokenbar-tray.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=TokenBar
Comment=AI usage limits in the system tray
Exec=python3 -I $APP_DIR/tray/tokenbar_tray.py
Icon=tokenbar
Terminal=false
X-GNOME-Autostart-enabled=true
DESKTOP
  # Reinicia a bandeja já, sem esperar o próximo login.
  pkill -f "tokenbar_tray.py" 2>/dev/null || true
  setsid -f python3 -I "$APP_DIR/tray/tokenbar_tray.py" >/dev/null 2>&1 < /dev/null || true
  echo "tray icon started (and set to start at login)"
fi

cat <<EOF

Done.
  * Collector:  systemctl --user status tokenbar-collector
  * State:      ~/.cache/tokenbar/state.json

EOF
if [[ $WANT_EXTENSION == 1 ]]; then
  cat <<EOF
IMPORTANT: on Wayland, GNOME Shell only loads a new extension (or new
extension code) when the session starts. Log out and back in.
EOF
fi
