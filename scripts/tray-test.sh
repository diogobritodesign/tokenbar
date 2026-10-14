#!/usr/bin/env bash
# Teste da bandeja: sobe um GNOME Shell headless e isolado com a extensão de
# AppIndicator (o host de bandeja do GNOME, que fala o mesmo protocolo do KDE,
# Xfce, Cinnamon etc.), roda o tokenbar_tray.py com dados de demonstração e
# confere registro, rótulo, ícone e menu pelo D-Bus.
#
#   scripts/tray-test.sh [--shots DIR]
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="appindicatorsupport@rgcjonas.gmail.com"
SHOTS=""
[[ "${1:-}" == "--shots" ]] && SHOTS="$(mkdir -p "$2" && cd "$2" && pwd)"

for tool in gnome-shell dbus-run-session gdbus python3 node; do
  command -v "$tool" >/dev/null || { echo "erro: $tool não encontrado" >&2; exit 2; }
done
if [[ ! -d "/usr/share/gnome-shell/extensions/$HOST" && ! -d "$HOME/.local/share/gnome-shell/extensions/$HOST" ]]; then
  echo "pulado: a extensão $HOST (host de bandeja) não está instalada" >&2
  exit 0
fi

WORK="$(mktemp -d)"
RUNTIME="/run/user/$(id -u)/tokenbar-tray-test-$$"
mkdir -m 700 "$RUNTIME"
trap 'kill "$(cat "$WORK/tray.pid" 2>/dev/null)" 2>/dev/null; sleep 1; rm -rf "$WORK" 2>/dev/null; fusermount -u "$RUNTIME/doc" 2>/dev/null; rm -rf "$RUNTIME" 2>/dev/null' EXIT
mkdir -p "$WORK/home" "$WORK/data/gnome-shell/extensions" "$WORK/config/tokenbar" "$WORK/cache/tokenbar"
[[ -d "$HOME/.local/share/gnome-shell/extensions/$HOST" ]] && cp -r "$HOME/.local/share/gnome-shell/extensions/$HOST" "$WORK/data/gnome-shell/extensions/"
node "$SRC/scripts/demo-state.mjs" "$WORK/cache/tokenbar/state.json" pt --update
echo '{"language": "pt"}' > "$WORK/config/tokenbar/config.json"

cat > "$WORK/inner.sh" <<'INNER'
FAILS=0
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$HOST']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '99'
gnome-shell --headless --unsafe-mode --wayland-display tokenbar-tray --virtual-monitor 1280x900 > "$WORK/shell.log" 2>&1 &
SHELL_PID=$!
sleep 10
GTK_A11Y=none WAYLAND_DISPLAY=tokenbar-tray python3 -I "$SRC/tray/tokenbar_tray.py" > "$WORK/tray.log" 2>&1 &
echo $! > "$WORK/tray.pid"
sleep 3

ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" | sed -E "s/^\(true, '(.*)'\)$/\1/"; }
check() { if [[ "$2" == "$3" ]]; then echo "  ok    $1"; else echo "  FALHA $1 (obtido: $2 | esperado: $3)"; FAILS=$((FAILS + 1)); fi; }
# Espera a condição em vez de dormir um tempo fixo: o teste não pode depender de a máquina estar folgada.
eventually() { local i out; for i in $(seq 40); do out="$(eval "$2")"; [[ "$out" == $3 ]] && break; sleep 0.25; done; echo "$out"; }
contains() { if [[ "$2" == *"$3"* ]]; then echo "  ok    $1"; else echo "  FALHA $1 (sem \"$3\" em: ${2:0:200})"; FAILS=$((FAILS + 1)); fi; }

NAME="org.kde.StatusNotifierItem-$(cat "$WORK/tray.pid")-1"
echo "Bandeja"
contains "registra o ícone no host de bandeja" \
  "$(gdbus call --session --dest org.kde.StatusNotifierWatcher --object-path /StatusNotifierWatcher --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems)" "$NAME"
get() { gdbus call --session --dest "$NAME" --object-path /StatusNotifierItem --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem "$1"; }
# Nos dados de demonstração o Antigravity tem uma janela em 100% de uso: é a mais crítica.
check "rótulo com a conta mais crítica" "$(get XAyatanaLabel)" "(<'AG 0%'>,)"
check "status fixo (o alerta fica na cor do anel)" "$(get Status)" "(<'Active'>,)"
contains "ícone desenhado em vários tamanhos" "$(get IconPixmap | head -c 40)" "[(16, 16,"
contains "dica com as contas" "$(get ToolTip)" "Claude (trabalho): 12% restante"
LAYOUT="$(gdbus call --session --dest "$NAME" --object-path /MenuBar --method com.canonical.dbusmenu.GetLayout 'int32 0' 'int32 -1' '@as []' 2>&1)"
contains "menu: cabeçalho" "$LAYOUT" "TokenBar · atualizado há"
contains "menu: aviso de versão nova" "$LAYOUT" "Atualização disponível: e4f5a6b"
contains "menu: conta com submenu de janelas" "$LAYOUT" "5h: 62% · reseta em"
contains "menu: custo do dia" "$LAYOUT" "uso hoje: R\$"
contains "menu: sobre com o autor" "$LAYOUT" "Site do autor (Diogo Brito)"
check "o host mostra o ícone na barra" "$(ev "Object.keys(Main.panel.statusArea).some(k => k.includes('$NAME'))")" "true"

# Clique esquerdo: abre a janela com o mesmo design do painel do GNOME.
check "o clique abre o painel, não o menu" "$(get ItemIsMenu)" "(<false>,)"
gdbus call --session --dest "$NAME" --object-path /StatusNotifierItem --method org.kde.StatusNotifierItem.Activate 1200 10 >/dev/null; sleep 2
check "a janela do painel aparece" "$(eventually x "ev \"global.display.list_all_windows().some(w => w.get_title() === 'TokenBar')\"" true)" "true"
if [[ -n "$SHOTS" ]]; then
  gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/tray-panel.png" >/dev/null
fi
gdbus call --session --dest "$NAME" --object-path /StatusNotifierItem --method org.kde.StatusNotifierItem.Activate 1200 10 >/dev/null; sleep 1
check "um segundo clique fecha a janela" "$(eventually x "ev \"global.display.list_all_windows().some(w => w.get_title() === 'TokenBar' && !w.minimized && w.showing_on_its_workspace())\"" false)" "false"

# Muda o estado e confere que a bandeja acompanha sem reiniciar.
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" en && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"
echo '{"language": "en", "bar": {"label": "all"}}' > "$XDG_CONFIG_HOME/tokenbar/config.json"
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" en && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"
check "acompanha o state.json e o config.json" "$(eventually x "get XAyatanaLabel" "*CLD2*")" "(<'CLD 62%  CLD2 12%  OAI 53%  AG 0%  GH 85%'>,)"
contains "menu em inglês depois da troca" "$(eventually x "gdbus call --session --dest $NAME --object-path /MenuBar --method com.canonical.dbusmenu.GetLayout 'int32 0' 'int32 -1' '@as []' 2>&1" "*Refresh now*")" "Refresh now"
: "$(gdbus call --session --dest "$NAME" --object-path /MenuBar --method com.canonical.dbusmenu.GetLayout 'int32 0' 'int32 -1' '@as []' 2>&1)" "Refresh now"

if [[ -n "$SHOTS" ]]; then
  ev "Main.overview.hide(); 1" >/dev/null; sleep 1
  gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/tray-bar.png" >/dev/null
  ev "(() => { const k = Object.keys(Main.panel.statusArea).find(k => k.includes('$NAME')); Main.panel.statusArea[k].menu.open(); return 1; })()" >/dev/null; sleep 1.5
  gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/tray-menu.png" >/dev/null
fi
# "Sair" pelo menu encerra o processo.
QUIT_ID="$(gdbus call --session --dest "$NAME" --object-path /MenuBar --method com.canonical.dbusmenu.GetLayout 'int32 0' 'int32 -1' '@as []' | grep -o "([0-9]*, {'label': <'Quit'>" | grep -o '^([0-9]*' | tr -d '(')"
gdbus call --session --dest "$NAME" --object-path /MenuBar --method com.canonical.dbusmenu.Event "$QUIT_ID" clicked '<0>' 'uint32 0' >/dev/null
check "\"Quit\" encerra a bandeja" "$(eventually x 'kill -0 "$(cat "$WORK/tray.pid")" 2>/dev/null && echo vivo || echo encerrado' encerrado)" "encerrado"
check "sem erros nem avisos do Python" "$(grep -c -E 'Traceback|Error|Warning' "$WORK/tray.log")" "0"
kill $SHELL_PID; wait $SHELL_PID 2>/dev/null
echo
if [[ $FAILS -eq 0 ]]; then echo "bandeja: todas as verificações passaram"; else echo "bandeja: $FAILS verificação(ões) falharam"; cat "$WORK/tray.log" | head -20; fi
exit $FAILS
INNER

env -u WAYLAND_DISPLAY -u DISPLAY WORK="$WORK" SRC="$SRC" HOST="$HOST" SHOTS="$SHOTS" HOME="$WORK/home" \
  XDG_RUNTIME_DIR="$RUNTIME" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
  timeout 120 dbus-run-session -- bash "$WORK/inner.sh" 2>/dev/null
