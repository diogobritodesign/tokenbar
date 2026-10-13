#!/usr/bin/env bash
# Remove tudo o que o install.sh colocou no sistema.
set -uo pipefail

UUID="tokenbar@tokenbar"

echo "==> Extension"
gnome-extensions disable "$UUID" 2>/dev/null || true
current="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || true)"
if [[ "$current" == *"'$UUID'"* ]]; then
  cleaned="$(sed -e "s/'$UUID', //" -e "s/, '$UUID'//" -e "s/'$UUID'//" <<<"$current")"
  [[ "$cleaned" == "[]" ]] && cleaned="@as []"
  gsettings set org.gnome.shell enabled-extensions "$cleaned"
fi
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
dconf reset -f /org/gnome/shell/extensions/tokenbar/ 2>/dev/null || true

echo "==> Collector"
systemctl --user disable --now tokenbar-collector.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/tokenbar-collector.service"
systemctl --user daemon-reload 2>/dev/null || true
rm -f "$HOME/.local/bin/tokenbar-collector"
rm -rf "$HOME/.local/share/tokenbar" "$HOME/.cache/tokenbar" "$HOME/.config/tokenbar"
rm -rf "$HOME/.local/share/fonts/tokenbar" "$HOME/.local/state/tokenbar"
fc-cache -f 2>/dev/null || true

echo "Removed. On Wayland, the extension code leaves the shell's memory at your next login."
