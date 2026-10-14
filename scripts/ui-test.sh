#!/usr/bin/env bash
# Teste de interface: sobe um GNOME Shell headless e isolado (não toca na sua
# sessão nem nas suas configurações), carrega a extensão com dados de
# demonstração, aciona os botões e confere o resultado.
#
#   scripts/ui-test.sh             roda as verificações
#   scripts/ui-test.sh --shots DIR também salva capturas de tela em DIR
#   TOKENBAR_TEST_WALLPAPER=/caminho/imagem.png  usa esse papel de parede (confere desfoque e sombra)
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="tokenbar@tokenbar"
SHOTS=""
[[ "${1:-}" == "--shots" ]] && SHOTS="$(mkdir -p "$2" && cd "$2" && pwd)"

for tool in gnome-shell dbus-run-session gdbus glib-compile-schemas node; do
  command -v "$tool" >/dev/null || { echo "erro: $tool não encontrado" >&2; exit 2; }
done

WORK="$(mktemp -d)"
# O soquete do Wayland tem limite de tamanho de caminho, por isso o runtime dir fica em /run.
RUNTIME="/run/user/$(id -u)/tokenbar-ui-test-$$"
mkdir -m 700 "$RUNTIME"
trap 'sleep 1; rm -rf "$WORK" 2>/dev/null; fusermount -u "$RUNTIME/doc" 2>/dev/null; rm -rf "$RUNTIME" 2>/dev/null' EXIT

mkdir -p "$WORK/home" "$WORK/data/gnome-shell/extensions" "$WORK/data/fonts" "$WORK/config" "$WORK/cache/tokenbar"
cp -r "$SRC/extension/$UUID" "$WORK/data/gnome-shell/extensions/"
glib-compile-schemas --strict "$WORK/data/gnome-shell/extensions/$UUID/schemas"
cp "$SRC"/fonts/*.ttf "$WORK/data/fonts/"
node "$SRC/scripts/demo-state.mjs" "$WORK/cache/tokenbar/state.json"

cat > "$WORK/inner.sh" <<'INNER'
UUID="tokenbar@tokenbar"
SCHEMA="org.gnome.shell.extensions.tokenbar"
GS="gsettings --schemadir $XDG_DATA_HOME/gnome-shell/extensions/$UUID/schemas"
FAILS=0

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '99'
if [[ -n "${TOKENBAR_TEST_WALLPAPER:-}" ]]; then
  gsettings set org.gnome.desktop.background picture-uri "file://$TOKENBAR_TEST_WALLPAPER"
  gsettings set org.gnome.desktop.background picture-uri-dark "file://$TOKENBAR_TEST_WALLPAPER"
fi
# As verificações usam os textos em português; o inglês é conferido no fim.
$GS set $SCHEMA language pt
gnome-shell --headless --unsafe-mode --wayland-display tokenbar-test --virtual-monitor 1280x1080 > "$WORK/shell.log" 2>&1 &
SHELL_PID=$!
sleep 10

# Avalia JS dentro do shell e devolve o resultado como texto.
ev() {
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "$1" | sed -E "s/^\(true, '(.*)'\)$/\1/; s/^\(false, .*$/ERRO-NO-EVAL/"
}
shot() {
  [[ -z "$SHOTS" ]] && return
  gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1" >/dev/null
}
check() {  # check DESCRIÇÃO OBTIDO ESPERADO
  if [[ "$2" == "$3" ]]; then echo "  ok    $1"; else echo "  FALHA $1 (obtido: $2 | esperado: $3)"; FAILS=$((FAILS + 1)); fi
}

I="Main.panel.statusArea['$UUID']"
# Procura um botão pelo texto e o aciona como um clique.
FIND="const find = (a, ok) => { if (ok(a)) return a; for (const c of a.get_children()) { const r = find(c, ok); if (r) return r; } return null; }; const byLabel = text => find($I.menu.box, a => a instanceof imports.gi.St.Button && a.label === text); const press = b => { if (b.toggle_mode) b.checked = !b.checked; b.emit('clicked', 1); return true; };"
click() { ev "(() => { $FIND const b = byLabel('$1'); return b ? press(b) : 'sem-botao'; })()"; }
# Aciona o botão de cabeçalho do cartão cujo nome é $1.
click_card() { ev "(() => { $FIND const b = find($I.menu.box, a => a instanceof imports.gi.St.Button && a.style_class === 'tokenbar-card-toggle' && !!find(a, c => c.text === '$1')); return b ? press(b) : 'sem-botao'; })()"; }
has_text() { ev "(() => { $FIND return !!find($I.menu.box, a => typeof a.text === 'string' && a.text.includes('$1')); })()"; }

echo "Extensão"
check "carrega sem erro" "$(gnome-extensions info $UUID | grep -c 'ACTIVE')" "1"
check "atalho de teclado registrado" "$(ev "Main.wm._allowedKeybindings['toggle-panel'] !== undefined")" "true"

echo "Barra superior"
ev "Main.overview.hide(); 1" >/dev/null
check "mostra as cinco contas" "$(ev "$I._panelBox.get_n_children()")" "5"
check "nenhuma sigla é cortada com reticências" "$(ev "(() => { $FIND return !!find($I._panelBox, a => a.clutter_text && a.clutter_text.get_layout().is_ellipsized()); })()")" "false"
shot bar-full.png
$GS set $SCHEMA bar-mode critical; sleep 0.5
check "modo 'mais crítica' mostra uma conta" "$(ev "$I._panelBox.get_n_children()")" "1"
$GS set $SCHEMA bar-mode full
$GS set $SCHEMA bar-hidden-providers "['copilot']"; sleep 0.5
check "conta oculta sai da barra" "$(ev "$I._panelBox.get_n_children()")" "4"
$GS set $SCHEMA bar-hidden-providers "[]"

echo "Painel"
ev "$I.menu.open(); 1" >/dev/null; sleep 1.5
check "abre" "$(ev "$I.menu.isOpen")" "true"
check "camada de desfoque recuada pelo raio do desfoque, dentro do painel" "$(ev "(() => { const b = $I._blurLayer, s = $I._surface; return [s.width - b.width, s.height - b.height, b.width > 300, b.get_effects().length].join(' '); })()")" "\"38 38 true 1\""
$GS set $SCHEMA background-blur false; sleep 0.5
check "desligar o desfoque desativa o efeito e deixa o fundo sólido" "$(ev "(() => { const e = $I._blurLayer.get_effects()[0]; return [e.enabled, $I._surface.has_style_class_name('tokenbar-surface-solid')].join(' '); })()")" "\"false true\""
$GS set $SCHEMA background-blur true; sleep 0.5
check "religar restaura" "$(ev "(() => { const e = $I._blurLayer.get_effects()[0]; return [e.enabled, $I._surface.has_style_class_name('tokenbar-surface-solid')].join(' '); })()")" "\"true false\""
check "mostra o custo do dia em reais" "$(has_text 'R\$ ')" "true"
check "cartão principal começa aberto" "$(has_text 'tokens hoje')" "true"
shot panel.png
click_card "GitHub Copilot" >/dev/null; sleep 0.6
check "clicar no cabeçalho abre o cartão" "$($GS get $SCHEMA expanded-providers)" "['claude-main', 'copilot']"
click_card "GitHub Copilot" >/dev/null; sleep 0.6
check "clicar de novo fecha" "$($GS get $SCHEMA expanded-providers)" "['claude-main']"
click "30 dias" >/dev/null; sleep 0.6
check "seletor de período troca para 30 dias" "$(ev "$I._period")" "\"30\""
click "Hoje" >/dev/null; sleep 0.6
click "tokens, modelos e sessões de hoje" >/dev/null; sleep 0.6
check "detalhes mostram a divisão dos tokens" "$(has_text 'leitura de cache')" "true"
check "detalhes mostram as sessões" "$(has_text 'loja-online')" "true"
$GS set $SCHEMA expanded-providers "['claude-main', 'claude-2', 'antigravity']"; sleep 0.8
check "ritmo recente aparece" "$(has_text 'esgota em ~')" "true"
check "janela em 100% avisa limite atingido" "$(has_text 'limite atingido')" "true"
check "conta fechada aparece como aviso suave" "$(has_text 'Antigravity fechado')" "true"
shot panel-open.png
$GS set $SCHEMA show-remaining false; sleep 0.8
check "modo 'usado' troca a legenda" "$(has_text 'usado')" "true"
$GS set $SCHEMA show-remaining true
$GS set $SCHEMA expanded-providers "['claude-main']"

echo "Configurações"
click "Configurações" >/dev/null; sleep 0.8
check "abre dentro do painel" "$(ev "$I.settingsOpen")" "true"
check "lista as contas com os interruptores" "$(has_text 'na barra')" "true"
shot settings.png
click "Dólares (US\$)" >/dev/null; sleep 0.4
check "troca a moeda" "$($GS get $SCHEMA currency)" "'usd'"
click "Reais (R\$)" >/dev/null
click "Só medidor" >/dev/null; sleep 0.4
check "troca o conteúdo da barra" "$($GS get $SCHEMA bar-mode)" "'dots'"
click "Completo" >/dev/null
ev "(() => { $FIND const s = find($I.menu.box, a => a instanceof imports.gi.St.Button && a.style_class === 'tokenbar-switch'); return press(s); })()" >/dev/null; sleep 0.6
check "interruptor desliga a coleta da primeira conta" "$($GS get $SCHEMA disabled-providers)" "['claude-main']"
check "a mudança chega ao config.json do coletor" "$(grep -c 'claude-main' "$XDG_CONFIG_HOME/tokenbar/config.json")" "1"
$GS set $SCHEMA disabled-providers "[]"
click "Esquerda" >/dev/null; sleep 1.2
check "mudar a posição recria o item e reabre as configurações" "$(ev "$I.settingsOpen")" "true"
click "Direita" >/dev/null; sleep 1.2
click "Voltar" >/dev/null; sleep 0.6
check "voltar retorna aos cartões" "$(ev "$I._view")" "\"main\""

echo "Inglês"
ev "$I.menu.close(); 1" >/dev/null
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" en && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"
$GS set $SCHEMA language en; sleep 2.5
check "o idioma chega ao config.json do coletor" "$(grep -c '"language": "en"' "$XDG_CONFIG_HOME/tokenbar/config.json")" "1"
ev "$I.menu.open(); 1" >/dev/null; sleep 1.5
# A troca de idioma dispara uma coleta; sem coletor neste ambiente, o botão mostra a falha, já em inglês.
check "botões em inglês" "$(ev "(() => { $FIND return !!byLabel('Settings') && !!byLabel('Failed — try again'); })()")" "true"
check "textos do painel em inglês" "$(has_text 'tokens today')" "true"
$GS set $SCHEMA currency usd; sleep 0.8
check "valores em dólar com separadores do inglês" "$(has_text '\$ 28.02')" "true"
# Só para a captura: o rótulo de falha é efeito deste ambiente sem coletor.
[[ -n "$SHOTS" ]] && ev "$I._refreshButton.label = 'Refresh'; 1" >/dev/null
shot panel-en.png
$GS set $SCHEMA expanded-providers "['claude-main', 'claude-2', 'antigravity']"; sleep 0.8
click "tokens, models and sessions today" >/dev/null; sleep 0.6
check "ritmo e detalhes em inglês" "$(ev "(() => { $FIND const has = s => !!find($I.menu.box, a => typeof a.text === 'string' && a.text.includes(s)); return has('runs out in ~') && has('cache reads'); })()")" "true"
shot panel-open-en.png
click "Settings" >/dev/null; sleep 0.8
check "configurações em inglês" "$(has_text 'Collection interval')" "true"
shot settings-en.png
$GS set $SCHEMA currency brl
click "Português" >/dev/null; sleep 2.5
check "trocar o idioma pelo painel reabre as configurações traduzidas" "$(ev "$I.settingsOpen && (() => { $FIND return !!byLabel('Voltar'); })()")" "true"
click "Voltar" >/dev/null; sleep 0.5
$GS set $SCHEMA expanded-providers "['claude-main']"
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"; sleep 1

echo "Atualizações e sobre"
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" pt --update && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"; sleep 1.5
ev "$I.menu.open(); 1" >/dev/null; sleep 1
check "faixa de atualização aparece com o resumo" "$(has_text 'e4f5a6b · Suporte ao Gemini CLI')" "true"
check "notificação de versão nova, uma vez" "$($GS get $SCHEMA update-notified)" "'e4f5a6b'"
shot panel-update.png
WIDTH="$(ev "$I.menu.box.get_preferred_width(-1)[1]")"
# Resumo bem longo: tem de quebrar a linha, não alargar o painel.
LONG='Fix blur spilling outside the panel; add background blur setting and a much longer description'
# "Atualizar agora" com um clone de mentira: o git pull traz um commit e o install.sh só marca que rodou.
git init -q --bare "$WORK/origin.git"; git clone -q "$WORK/origin.git" "$WORK/clone" 2>/dev/null
printf '#!/bin/sh\ntouch "%s/installed"\n' "$WORK" > "$WORK/clone/install.sh"; chmod +x "$WORK/clone/install.sh"
git -C "$WORK/clone" add install.sh; git -C "$WORK/clone" -c user.name=t -c user.email=t@t commit -qm one; git -C "$WORK/clone" push -q origin HEAD 2>/dev/null
git clone -q "$WORK/origin.git" "$WORK/other"; echo x > "$WORK/other/new"; git -C "$WORK/other" add new
git -C "$WORK/other" -c user.name=t -c user.email=t@t commit -qm two; git -C "$WORK/other" push -q origin HEAD 2>/dev/null
TOKENBAR_DEMO_SUMMARY="$LONG" TOKENBAR_DEMO_SOURCE="$WORK/clone" node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" pt --update && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"; sleep 1.5
check "resumo longo não alarga o painel" "$(ev "$I.menu.box.get_preferred_width(-1)[1]")" "$WIDTH"
check "botão de atualizar com um clique" "$(ev "(() => { $FIND return !!byLabel('Atualizar agora'); })()")" "true"
shot panel-update-long.png
click "Atualizar agora" >/dev/null
for _ in $(seq 40); do [[ -f "$WORK/installed" ]] && break; sleep 0.25; done; sleep 0.5
check "atualizar agora faz git pull e roda o install.sh" "$([[ -f "$WORK/installed" && -f "$WORK/clone/new" ]] && echo sim)" "sim"
check "avisa para sair e entrar na sessão" "$(has_text 'Pronto! Saia e entre de novo na sessão para o painel novo carregar.')" "true"
shot panel-update-done.png
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" pt --update && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"; sleep 1.5
click "Configurações" >/dev/null; sleep 0.8
check "sobre mostra o autor" "$(has_text 'Criado por Diogo Brito')" "true"
check "sobre tem os links do site e do GitHub" "$(ev "(() => { $FIND return !!byLabel('Site do autor') && !!byLabel('Código no GitHub'); })()")" "true"
check "sobre mostra que há versão nova" "$(has_text 'Atualização disponível: e4f5a6b')" "true"
ev "(() => { $FIND const s = find($I.menu.box, a => a instanceof imports.gi.St.Button && a.style_class === 'tokenbar-switch' && a.get_parent()?.get_children?.()[0]?.text === 'Avisar sobre atualizações'); return s ? press(s) : 'sem'; })()" >/dev/null; sleep 0.6
check "interruptor de atualizações vai para o config.json" "$(grep -c '"updateCheck": false' "$XDG_CONFIG_HOME/tokenbar/config.json")" "1"
shot settings-about.png
click "Voltar" >/dev/null; sleep 0.5
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"; sleep 1.5

echo "Robustez"
echo '{ quebrado' > "$XDG_CACHE_HOME/tokenbar/state.json"; sleep 1.5
check "JSON inválido não quebra (barra mostra traço)" "$(ev "$I._state === null && $I._panelBox.get_n_children() === 2")" "true"
check "painel avisa que não há dados" "$(has_text 'sem dados')" "true"
node "$SRC/scripts/demo-state.mjs" "$XDG_CACHE_HOME/tokenbar/state.tmp" && mv "$XDG_CACHE_HOME/tokenbar/state.tmp" "$XDG_CACHE_HOME/tokenbar/state.json"; sleep 1.5
check "volta sozinha quando o arquivo é regravado" "$(ev "$I._panelBox.get_n_children()")" "5"
click "Atualizar" >/dev/null; sleep 1.5
check "atualizar sem coletor instalado falha sem travar" "$(ev "$I._refreshing")" "false"
check "e o botão avisa que falhou" "$(ev "$I._refreshButton.label")" "\"Falhou — tentar de novo\""
ev "$I.menu.close(); 1" >/dev/null
for round in 1 2 3; do gnome-extensions disable $UUID; sleep 0.7; gnome-extensions enable $UUID; sleep 0.7; done
check "três ciclos de desligar/ligar" "$(gnome-extensions info $UUID | grep -c 'ACTIVE')" "1"
check "nenhum erro de JS no log do shell" "$(grep -c -E "JS ERROR|$UUID.*(Error|error)|Clutter-CRITICAL" "$WORK/shell.log")" "0"

kill $SHELL_PID; wait $SHELL_PID 2>/dev/null
echo
if [[ $FAILS -eq 0 ]]; then echo "interface: todas as verificações passaram"; else echo "interface: $FAILS verificação(ões) falharam"; grep -E "JS ERROR|CRITICAL" -A6 "$WORK/shell.log" | head -40; fi
exit $FAILS
INNER

env -u WAYLAND_DISPLAY -u DISPLAY WORK="$WORK" SRC="$SRC" SHOTS="$SHOTS" HOME="$WORK/home" TOKENBAR_TEST_NO_COLLECTOR=1 \
  XDG_RUNTIME_DIR="$RUNTIME" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
  timeout 180 dbus-run-session -- bash "$WORK/inner.sh" 2>/dev/null
