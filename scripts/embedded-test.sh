#!/usr/bin/env bash
# Teste do modo "extensions.gnome.org": shell headless e isolado, sem o
# coletor em Node instalado, com a extensão empacotada pelo pack-extension.sh.
# A própria extensão deve subir o coletor em GJS, que lê uma pasta pessoal de
# mentira e grava o state.json; o painel mostra o resultado.
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="tokenbar@tokenbar"
for tool in gnome-shell dbus-run-session gdbus gjs node zip; do
  command -v "$tool" >/dev/null || { echo "erro: $tool não encontrado" >&2; exit 2; }
done
WORK="$(mktemp -d)"
RUNTIME="/run/user/$(id -u)/tokenbar-embedded-test-$$"
mkdir -m 700 "$RUNTIME"
trap 'sleep 1; rm -rf "$WORK" 2>/dev/null; fusermount -u "$RUNTIME/doc" 2>/dev/null; rm -rf "$RUNTIME" 2>/dev/null' EXIT

"$SRC/scripts/pack-extension.sh" "$WORK/dist" >/dev/null
mkdir -p "$WORK/data/gnome-shell/extensions" "$WORK/config/tokenbar" "$WORK/cache" "$WORK/state"
cp -r "$WORK/dist/$UUID" "$WORK/data/gnome-shell/extensions/"
glib-compile-schemas "$WORK/data/gnome-shell/extensions/$UUID/schemas"
echo '{"language": "pt", "updateCheck": false}' > "$WORK/config/tokenbar/config.json"

# Pasta pessoal de mentira: uma conta do Claude com login vencido (sem rede) e
# conversas de hoje.
node --input-type=module - "$WORK/home" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';
const dir = path.join(process.argv[2], '.claude');
await fs.mkdir(path.join(dir, 'projects', 'p'), { recursive: true });
await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() - 1000, subscriptionType: 'pro' } }));
const line = (id, output) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId: 's', cwd: '/home/u/demo',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: output } } });
await fs.writeFile(path.join(dir, 'projects', 'p', 'a.jsonl'), `${line('m1', 1_000_000)}\n${line('m2', 500_000)}\n`);
NODE

cat > "$WORK/inner.sh" <<'INNER'
FAILS=0
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '99'
gnome-shell --headless --unsafe-mode --wayland-display tokenbar-embedded --virtual-monitor 1280x900 > "$WORK/shell.log" 2>&1 &
SHELL_PID=$!
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" | sed -E "s/^\(true, '(.*)'\)$/\1/"; }
check() { if [[ "$2" == "$3" ]]; then echo "  ok    $1"; else echo "  FALHA $1 (obtido: $2 | esperado: $3)"; FAILS=$((FAILS + 1)); fi; }
collectors() { pgrep -f "$WORK/data/gnome-shell/extensions/$UUID/collector/gjs/tokenbar-collector.js" | wc -l; }
STATE="$XDG_CACHE_HOME/tokenbar/state.json"
for _ in $(seq 40); do [[ -f "$STATE" ]] && break; sleep 0.5; done
sleep 2

echo "Modo sem Node (extensions.gnome.org)"
check "a extensão usa o coletor embutido" "$(ev "Main.extensionManager.lookup('$UUID').stateObj.usesEmbeddedCollector")" "true"
check "um coletor em GJS rodando como processo filho" "$(collectors)" "1"
check "o coletor gravou o state.json" "$([[ -f "$STATE" ]] && echo sim || echo não)" "sim"
check "leu as conversas de hoje" "$(node -e "const s=require('$STATE'); console.log(s.providers[0].id + ' ' + s.providers[0].tokensToday + ' ' + s.providers[0].status)")" "claude-main 1500000 unauthorized"
check "o painel mostra a conta" "$(ev "Main.panel.statusArea['$UUID']._providers().map(p => p.label).join(',')")" "\"CLD\""
gnome-extensions disable "$UUID"; sleep 1.5
check "desligar a extensão encerra o coletor" "$(collectors)" "0"
gnome-extensions enable "$UUID"; sleep 2
check "religar sobe de novo" "$(collectors)" "1"
ev "Main.panel.statusArea['$UUID'].menu.open(); 1" >/dev/null; sleep 0.5
ev "Main.panel.statusArea['$UUID']._refresh(); 1" >/dev/null; sleep 4
check "\"Atualizar\" roda o coletor embutido" "$(ev "Main.panel.statusArea['$UUID']._refreshButton.label")" "\"Atualizar\""
check "sem erros de JS no log do shell" "$(grep -c -E "JS ERROR|$UUID.*Error|Clutter-CRITICAL" "$WORK/shell.log")" "0"
kill $SHELL_PID; wait $SHELL_PID 2>/dev/null
sleep 1
check "o coletor não fica órfão quando o shell sai" "$(collectors)" "0"
echo
if [[ $FAILS -eq 0 ]]; then echo "modo embutido: todas as verificações passaram"; else echo "modo embutido: $FAILS verificação(ões) falharam"; grep -E "tokenbar|JS ERROR" "$WORK/shell.log" | head -10; fi
exit $FAILS
INNER

env -u WAYLAND_DISPLAY -u DISPLAY WORK="$WORK" UUID="$UUID" HOME="$WORK/home" \
  XDG_RUNTIME_DIR="$RUNTIME" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" XDG_STATE_HOME="$WORK/state" \
  timeout 120 dbus-run-session -- bash "$WORK/inner.sh" 2>/dev/null
