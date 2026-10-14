import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {
    EMPTY, formatAge, formatAmount, formatReset, formatTokens, paceOf, windowsOf, worstPct,
} from './lib/format.js';
import {
    CONTENT_WIDTH, labeled, makeChart, makeChoice, makeDot, makeRing, makeStepper, makeSwitch, openFolder,
    openUri, setLevel, settingRow,
} from './lib/widgets.js';
import {getLanguage, t} from './lib/i18n.js';
import {BAR_MODES, CURRENCIES, DISPLAY_MODES, LANGUAGE_MODES, POSITIONS, PROVIDERS} from './providers.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const POLL_SECONDS = 30;
const OPEN_TICK_SECONDS = 5;
const RELOAD_DEBOUNCE_MS = 250;
// Altura ocupada por cabeçalho, rodapé, margens e sombra do painel, em px de CSS.
const POPUP_CHROME_HEIGHT = 170;
const STALE_AFTER_MS = 10 * 60 * 1000;
// Vão entre as duas colunas de janelas, em px de CSS.
const COLUMN_GAP = 14;
// Medidor em blocos: cada bloco vale 10%.
const SEGMENTS = 10;
const SEGMENT_GAP = 3;
// Desfoque do que fica atrás do painel; valor baixo de propósito.
const BLUR_RADIUS = 18;
// Situações passageiras em que o último valor continua valendo.
const SOFT_STATUSES = ['idle', 'rate_limited'];
// Autor e endereços mostrados em "Sobre".
const AUTHOR = 'Diogo Brito';
const AUTHOR_URL = 'https://diogobrito.com.br/';
const REPOSITORY_URL = 'https://github.com/diogobritodesign/tokenbar';
// [valor, chave do rótulo, quantos dias somar]
const PERIODS = [
    ['today', 'period.today', 1],
    ['7', 'period.7', 7],
    ['30', 'period.30', 30],
];

// "US$" em português, "$" em inglês.
const dollarSign = () => (getLanguage() === 'pt' ? 'US$' : '$');

// Traduz os rótulos de uma lista de opções [valor, chave].
const localized = options => options.map(([value, key]) => [value, t(key)]);

export const TokenBarIndicator = GObject.registerClass(
class TokenBarIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'TokenBar');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._state = null;
        this._loading = false;
        this._loadQueued = false;
        this._refreshing = false;
        this._view = 'main';
        this._period = 'today';
        this._expanded = new Set();
        this._renderId = 0;
        this._debounceId = 0;
        this._pollId = 0;
        this._tickId = 0;

        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'tokenbar']);
        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev([cacheDir, 'state.json']));

        this._panelBox = new St.BoxLayout({
            style_class: 'tokenbar-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._buildPopup();

        this._settings.connectObject(
            'changed', () => this._render(),
            'changed::background-blur', () => this._applyBlurSetting(),
            this);
        this.menu.connectObject('open-state-changed', (_menu, open) => this._onMenuToggled(open), this);

        // O coletor troca o arquivo com rename, então observa-se o diretório.
        // Ele é criado aqui se ainda não existe (primeira execução), senão o
        // monitor falha e o painel só veria os dados na próxima consulta.
        GLib.mkdir_with_parents(cacheDir, 0o700);
        try {
            this._monitor = Gio.File.new_for_path(cacheDir)
                .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connectObject('changed', () => this._queueLoad(), this);
        } catch {
            this._monitor = null;
        }

        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._load();
            return GLib.SOURCE_CONTINUE;
        });

        this._render();
        this._load();
    }

    _buildPopup() {
        // A caixa do menu fica invisível; quem desenha fundo, borda e sombra é
        // `surface`. O desfoque vai numa camada própria, do tamanho exato do
        // painel: aplicado num ator com sombra ele cobre também a área da
        // sombra e aparece como um retângulo em volta. O desfoque do shell é
        // retangular, então nos quatro cantos arredondados podem sobrar
        // alguns pixels desfocados por fora da curva.
        this.menu.box.add_style_class_name('tokenbar-menu');
        const surface = new St.Widget({
            style_class: 'tokenbar-surface',
            layout_manager: new Clutter.BinLayout(),
        });
        this.menu.box.add_child(surface);
        this._surface = surface;

        // O efeito desenha um pouco além da área do ator (cerca do raio do
        // desfoque), por isso a camada fica recuada essa distância para
        // dentro: o resultado termina na borda do painel e não vaza.
        const blurHolder = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: `padding: ${BLUR_RADIUS}px;`,
            x_expand: true,
            y_expand: true,
        });
        const blurLayer = new St.Widget({x_expand: true, y_expand: true});
        blurHolder.add_child(blurLayer);
        blurLayer.add_effect(new Shell.BlurEffect({
            radius: BLUR_RADIUS,
            brightness: 1.0,
            mode: Shell.BlurMode.BACKGROUND,
        }));
        surface.add_child(blurHolder);
        this._blurLayer = blurLayer;
        this._applyBlurSetting();

        this._popup = new St.BoxLayout({
            style_class: 'tokenbar-popup',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        surface.add_child(this._popup);

        const header = new St.BoxLayout({style_class: 'tokenbar-header'});
        header.add_child(new St.Icon({
            style_class: 'tokenbar-logo',
            gicon: Gio.FileIcon.new(this._extension.dir.get_child('icons').get_child('tokenbar-mark.svg')),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        // Logotipo: "Token" na cor do texto, "Bar" no verde da marca.
        const title = new St.Label({style_class: 'tokenbar-title', y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.set_markup('Token<span foreground="#4fe37b">Bar</span>');
        header.add_child(title);
        const agePill = new St.BoxLayout({
            style_class: 'tokenbar-pill',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._freshDot = makeDot('ok');
        agePill.add_child(this._freshDot);
        this._ageLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        agePill.add_child(this._ageLabel);
        header.add_child(agePill);
        this._popup.add_child(header);

        this._warning = new St.Label({style_class: 'tokenbar-warning', visible: false});
        this._popup.add_child(this._warning);
        this._serviceNote = new St.Label({style_class: 'tokenbar-warning', visible: false});
        this._popup.add_child(this._serviceNote);

        // Faixa de versão nova; só aparece quando o coletor encontrou uma.
        this._updateBox = new St.BoxLayout({
            style_class: 'tokenbar-update',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this._updateBox.add_child(new St.Label({style_class: 'tokenbar-update-title', text: t('update.title')}));
        this._updateSummary = new St.Label({style_class: 'tokenbar-small'});
        this._updateSummary.clutter_text.line_wrap = true;
        this._updateSummary.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._updateBox.add_child(this._updateSummary);
        const updateRow = new St.BoxLayout({style_class: 'tokenbar-set-row'});
        updateRow.add_child(new St.Label({
            style_class: 'tokenbar-tiny tokenbar-update-how',
            text: t('update.how'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const updateButton = new St.Button({style_class: 'tokenbar-button tokenbar-button-small tokenbar-button-primary', label: t('update.view'), can_focus: true});
        updateButton.connect('clicked', () => {
            this.menu.close();
            openUri(this._state?.update?.url ?? REPOSITORY_URL);
        });
        updateRow.add_child(updateButton);
        this._updateBox.add_child(updateRow);
        this._popup.add_child(this._updateBox);

        // Cartões e configurações rolam se não couberem na altura da tela.
        const scrolled = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._scroll = new St.ScrollView({
            style_class: 'tokenbar-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            child: scrolled,
        });
        this._popup.add_child(this._scroll);

        this._sections = new St.BoxLayout({
            style_class: 'tokenbar-sections',
            orientation: Clutter.Orientation.VERTICAL,
        });
        scrolled.add_child(this._sections);

        this._settingsBox = new St.BoxLayout({
            style_class: 'tokenbar-sections',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        scrolled.add_child(this._settingsBox);

        // Controle segmentado, como um par de abas em pílula.
        const footer = new St.BoxLayout({style_class: 'tokenbar-segmented'});
        this._popup.add_child(footer);

        this._refreshButton = new St.Button({
            style_class: 'tokenbar-button tokenbar-button-primary',
            label: t('refresh'),
            can_focus: true,
            x_expand: true,
        });
        this._refreshButton.connect('clicked', () => this._refresh());
        footer.add_child(this._refreshButton);

        this._viewButton = new St.Button({
            style_class: 'tokenbar-button',
            label: t('settings'),
            can_focus: true,
            x_expand: true,
        });
        this._viewButton.connect('clicked', () => {
            this._setView(this._view === 'settings' ? 'main' : 'settings');
        });
        footer.add_child(this._viewButton);
    }

    // Sem desfoque, o painel fica com fundo quase opaco para continuar legível.
    _applyBlurSetting() {
        const enabled = this._settings.get_boolean('background-blur');
        this._blurLayer.get_effects().forEach(effect => effect.set_enabled(enabled));
        if (enabled)
            this._surface.remove_style_class_name('tokenbar-surface-solid');
        else
            this._surface.add_style_class_name('tokenbar-surface-solid');
    }

    // Pede uma coleta imediata (ex.: depois de trocar o idioma).
    refreshNow() {
        this._refresh();
    }

    get settingsOpen() {
        return this.menu.isOpen && this._view === 'settings';
    }

    openSettings() {
        this.menu.open();
        this._setView('settings');
    }

    // As configurações ficam no próprio painel: trocam de lugar com os cartões.
    _setView(view) {
        this._view = view;
        const inSettings = view === 'settings';
        this._viewButton.label = inSettings ? t('back') : t('settings');
        if (inSettings)
            this._buildSettings();
        else
            this._settingsBox.destroy_all_children();
        this._settingsBox.visible = inSettings;
        this._renderPopup();
    }

    _settingsCard(title) {
        const card = new St.BoxLayout({
            style_class: 'tokenbar-card tokenbar-set-card',
            style: `width: ${CONTENT_WIDTH}px;`,
            orientation: Clutter.Orientation.VERTICAL,
        });
        card.add_child(new St.Label({style_class: 'tokenbar-group-title', text: title}));
        this._settingsBox.add_child(card);
        return card;
    }

    _buildSettings() {
        const settings = this._settings;
        this._settingsBox.destroy_all_children();

        const listSwitch = (key, id) => {
            const column = new St.Bin({style_class: 'tokenbar-set-column'});
            column.set_child(makeSwitch(!settings.get_strv(key).includes(id), active => {
                const list = settings.get_strv(key).filter(entry => entry !== id);
                if (!active)
                    list.push(id);
                settings.set_strv(key, list);
            }));
            return column;
        };
        const columnTitle = text => new St.Label({
            style_class: 'tokenbar-set-column tokenbar-muted tokenbar-tiny',
            text,
        });

        const accounts = this._settingsCard(t('set.accounts'));
        const legend = new St.BoxLayout({style_class: 'tokenbar-set-row'});
        legend.add_child(new St.Widget({x_expand: true}));
        legend.add_child(columnTitle(t('set.collect')));
        legend.add_child(columnTitle(t('set.inBar')));
        accounts.add_child(legend);
        // As contas vêm do coletor (as que existem nesta máquina); a lista
        // fixa só serve enquanto ele ainda não gravou nada.
        const accountList = Array.isArray(this._state?.accounts) && this._state.accounts.length > 0
            ? this._state.accounts : PROVIDERS;
        for (const provider of accountList) {
            const row = new St.BoxLayout({style_class: 'tokenbar-set-row'});
            row.add_child(new St.Label({
                style_class: 'tokenbar-tag',
                text: provider.label,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                text: provider.name,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(listSwitch('disabled-providers', provider.id));
            row.add_child(listSwitch('bar-hidden-providers', provider.id));
            accounts.add_child(row);
        }

        const display = this._settingsCard(t('set.display'));
        display.add_child(labeled(t('set.language'), makeChoice(localized(LANGUAGE_MODES), settings.get_string('language'),
            value => settings.set_string('language', value))));
        display.add_child(labeled(t('set.percentages'), makeChoice(localized(DISPLAY_MODES),
            settings.get_boolean('show-remaining') ? 'remaining' : 'used',
            value => settings.set_boolean('show-remaining', value === 'remaining'))));
        display.add_child(settingRow(t('set.blur'),
            makeSwitch(settings.get_boolean('background-blur'),
                active => settings.set_boolean('background-blur', active))));
        display.add_child(labeled(t('set.currency'), makeChoice(localized(CURRENCIES), settings.get_string('currency'),
            value => settings.set_string('currency', value))));

        const bar = this._settingsCard(t('set.topBar'));
        bar.add_child(labeled(t('set.content'), makeChoice(localized(BAR_MODES), settings.get_string('bar-mode'),
            value => settings.set_string('bar-mode', value))));
        bar.add_child(labeled(t('set.position'), makeChoice(localized(POSITIONS), settings.get_string('panel-position'),
            value => settings.set_string('panel-position', value))));
        bar.add_child(settingRow(t('set.order'), this._intStepper('panel-index', 1, 0, 20, v => String(v))));

        const off = value => (value > 0 ? String(value) : t('set.none'));
        const alerts = this._settingsCard(t('set.alerts'));
        alerts.add_child(settingRow(t('set.warnAt'),
            this._intStepper('warn-threshold', 5, 5, () => settings.get_int('crit-threshold') - 5, v => `${v}%`)));
        alerts.add_child(settingRow(t('set.critAbove'),
            this._intStepper('crit-threshold', 5, () => settings.get_int('warn-threshold') + 5, 100, v => `${v}%`)));
        alerts.add_child(settingRow(t('set.goalDay'),
            this._intStepper('budget-daily', 10, 0, 5000, off)));
        alerts.add_child(settingRow(t('set.goalMonth'),
            this._intStepper('budget-monthly', 100, 0, 100000, off)));
        alerts.add_child(settingRow(t('set.notifications'),
            makeSwitch(settings.get_boolean('notifications'),
                active => settings.set_boolean('notifications', active))));
        alerts.add_child(new St.Label({
            style_class: 'tokenbar-muted tokenbar-tiny',
            text: t('set.notificationsHint'),
        }));

        const data = this._settingsCard(t('set.data'));
        data.add_child(settingRow(t('set.interval'),
            this._intStepper('collector-interval', 30, 60, 600, v => `${v} s`)));
        const exportButton = new St.Button({
            style_class: 'tokenbar-button tokenbar-button-primary',
            label: t('set.export'),
            can_focus: true,
            x_expand: true,
        });
        exportButton.connect('clicked', () => this._exportHistory(exportButton));
        data.add_child(exportButton);
        data.add_child(new St.Label({
            style_class: 'tokenbar-muted tokenbar-tiny',
            text: t('set.shortcut'),
        }));

        this._buildAboutCard();
    }

    _buildAboutCard() {
        const settings = this._settings;
        const about = this._settingsCard(t('set.about'));
        const update = this._state?.update;
        const version = this._extension.metadata['version-name'] ?? String(this._extension.metadata.version ?? '');
        const build = update?.installed && update.installed !== version ? ` (${update.installed})` : '';
        about.add_child(new St.Label({text: `TokenBar · ${t('about.version', {version})}${build}`}));
        about.add_child(new St.Label({style_class: 'tokenbar-muted tokenbar-small', text: `${t('about.createdBy', {name: AUTHOR})} · ${t('about.license')}`}));

        const links = new St.BoxLayout({style_class: 'tokenbar-segmented tokenbar-choice'});
        for (const [label, uri] of [[t('about.site'), AUTHOR_URL], [t('about.code'), REPOSITORY_URL]]) {
            const link = new St.Button({style_class: 'tokenbar-button tokenbar-button-small', label, can_focus: true, x_expand: true});
            link.connect('clicked', () => {
                this.menu.close();
                openUri(uri);
            });
            links.add_child(link);
        }
        about.add_child(links);

        about.add_child(settingRow(t('set.updateCheck'),
            makeSwitch(settings.get_boolean('update-check'),
                active => settings.set_boolean('update-check', active))));

        const status = !update ? t('set.updateUnknown')
            : update.available ? `${t('update.title')}: ${update.latest}` : t('set.upToDate');
        const statusRow = new St.BoxLayout({style_class: 'tokenbar-set-row'});
        const statusLabel = new St.Label({
            style_class: update?.available ? 'tokenbar-small tokenbar-pace' : 'tokenbar-small tokenbar-muted',
            text: status,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusLabel.clutter_text.line_wrap = true;
        statusRow.add_child(statusLabel);
        const checkNow = new St.Button({style_class: 'tokenbar-button tokenbar-button-small tokenbar-button-primary', label: t('set.updateCheckNow'), can_focus: true});
        checkNow.connect('clicked', async () => {
            checkNow.label = t('set.updateChecking');
            checkNow.reactive = false;
            await this._refresh('--check-update');
            if (!this._destroyed && this._view === 'settings')
                this._setView('settings');
        });
        statusRow.add_child(checkNow);
        about.add_child(statusRow);
    }

    async _exportHistory(button) {
        const folder = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? GLib.get_home_dir();
        const target = GLib.build_filenamev([folder, 'tokenbar-historico.csv']);
        button.reactive = false;
        let ok = false;
        try {
            const argv = this._extension.collectorCommand(['--export-csv', target]);
            if (!argv)
                throw new Error('no collector');
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            await proc.wait_async(this._cancellable);
            ok = proc.get_successful();
        } catch {
            ok = false;
        }
        if (this._destroyed)
            return;
        Main.notify(ok ? t('notify.exported') : t('notify.exportFailed'), ok ? target : '');
        button.reactive = true;
    }

    _intStepper(key, step, min, max, format) {
        const settings = this._settings;
        const bound = limit => (typeof limit === 'function' ? limit() : limit);
        return makeStepper(
            () => settings.get_int(key),
            direction => {
                const next = settings.get_int(key) + direction * step;
                settings.set_int(key, Math.min(Math.max(next, bound(min)), bound(max)));
            },
            format);
    }

    _queueLoad() {
        if (this._debounceId)
            return;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._load();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _load() {
        if (this._destroyed)
            return;
        if (this._loading) {
            this._loadQueued = true;
            return;
        }
        this._loading = true;
        let state = null;
        try {
            const [bytes] = await this._stateFile.load_contents_async(this._cancellable);
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (parsed && Array.isArray(parsed.providers))
                state = parsed;
        } catch {
            // Arquivo ausente, pela metade ou inválido: a interface mostra "—".
        }
        if (this._destroyed)
            return;
        this._loading = false;
        this._state = state;
        this._extension.checkAlerts(state);
        this._render();
        if (this._loadQueued) {
            this._loadQueued = false;
            this._load();
        }
    }

    _providers() {
        const providers = this._state?.providers ?? [];
        return providers.filter(p => p && typeof p.id === 'string');
    }

    _level(provider) {
        const pct = worstPct(provider);
        if (pct === null || !['ok', 'rate_limited', 'idle'].includes(provider.status))
            return 'off';
        return this._pctLevel(pct);
    }

    _pctLevel(pct) {
        const warn = this._settings.get_int('warn-threshold');
        const crit = Math.max(this._settings.get_int('crit-threshold'), warn);
        if (pct > crit)
            return 'crit';
        if (pct >= warn)
            return 'warn';
        return 'ok';
    }

    // Redesenha no próximo ciclo: usado por botões que ficam dentro do que
    // será reconstruído, para não destruí-los no meio do próprio clique.
    _queueRender() {
        if (this._renderId)
            return;
        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._renderId = 0;
            this._renderPopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    _render() {
        if (this._destroyed)
            return;
        this._renderPanel();
        if (this.menu.isOpen)
            this._queueRender();
    }

    _renderPanel() {
        this._panelBox.destroy_all_children();

        const hidden = this._settings.get_strv('bar-hidden-providers');
        const mode = this._settings.get_string('bar-mode');
        let providers = this._providers().filter(p => !hidden.includes(p.id));

        if (providers.length === 0) {
            this._panelBox.add_child(makeRing('off', null));
            this._panelBox.add_child(new St.Label({
                style_class: 'tokenbar-panel-value',
                text: EMPTY,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        // Conta sem nenhum dado (ex.: login nunca feito) só ocuparia espaço na
        // barra com um traço; fica de fora, a menos que todas estejam assim.
        const withData = providers.filter(p => worstPct(p) !== null);
        if (withData.length > 0)
            providers = withData;

        if (mode === 'critical') {
            const rank = p => (this._level(p) === 'off' ? -1 : worstPct(p));
            providers = [providers.reduce((a, b) => (rank(b) > rank(a) ? b : a))];
        }

        for (const provider of providers) {
            const level = this._level(provider);
            const pct = worstPct(provider);
            const item = new St.BoxLayout({style_class: 'tokenbar-panel-item'});
            item.add_child(makeRing(level, this._shown(pct)));
            if (mode !== 'dots') {
                const name = new St.Label({
                    style_class: 'tokenbar-panel-name',
                    text: provider.label ?? provider.id,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                // Com muitas contas a barra aperta; a sigla nunca vira "CL…".
                name.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                item.add_child(name);
                const value = new St.Label({
                    style_class: 'tokenbar-panel-value',
                    text: pct === null ? EMPTY : `${this._shown(pct)}%`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                value.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                if (level === 'off')
                    value.add_style_class_name('tokenbar-panel-name');
                item.add_child(value);
            }
            this._panelBox.add_child(item);
        }
    }

    _renderPopup() {
        const now = Date.now();
        const providers = this._providers();
        const updatedAt = Date.parse(this._state?.updatedAt);
        const stale = !Number.isFinite(updatedAt) || now - updatedAt > STALE_AFTER_MS;

        let warning = '';
        if (!this._state)
            warning = t('warn.noData');
        else if (stale)
            warning = t('warn.stale');
        else if (providers.length === 0)
            warning = t('warn.noAccounts');
        const inMain = this._view === 'main';
        this._warning.text = warning;
        this._warning.visible = inMain && warning !== '';

        const troubled = (Array.isArray(this._state?.services) ? this._state.services : [])
            .filter(service => service && service.indicator && service.indicator !== 'none');
        this._serviceNote.text = troubled
            .map(service => t('service.incident', {name: service.name, text: service.description || service.indicator}))
            .join('\n');
        this._serviceNote.visible = inMain && troubled.length > 0;

        const update = this._state?.update;
        this._updateBox.visible = inMain && update?.available === true;
        this._updateSummary.text = update?.summary ? `${update.latest} · ${update.summary}` : String(update?.latest ?? '');

        this._sections.destroy_all_children();
        if (inMain) {
            const summary = this._buildSummary(providers);
            if (summary)
                this._sections.add_child(summary);
            for (const provider of providers)
                this._sections.add_child(this._buildSection(provider, now));
        }
        this._sections.visible = inMain && providers.length > 0;

        setLevel(this._freshDot, stale ? 'warn' : 'ok');
        this._ageLabel.text = Number.isFinite(updatedAt) ? formatAge(now - updatedAt) : EMPTY;
    }

    // O percentual que vai para a tela: quanto resta (padrão) ou quanto foi
    // usado. Cores e alertas continuam sempre baseados no uso.
    _shown(usedPct) {
        if (usedPct === null)
            return null;
        return this._settings.get_boolean('show-remaining') ? 100 - usedPct : usedPct;
    }

    // Custo em US$ convertido para a moeda escolhida. Sem cotação disponível,
    // cai para dólares em vez de inventar um valor em reais.
    _money(usd) {
        return `${this._currencySymbol()} ${formatAmount(this._inCurrency(usd))}`;
    }

    _usesBrl() {
        const rate = Number(this._state?.fx?.usdBrl);
        return this._settings.get_string('currency') === 'brl' && Number.isFinite(rate) && rate > 0;
    }

    _currencySymbol() {
        return this._usesBrl() ? 'R$' : dollarSign();
    }

    _inCurrency(usd) {
        return this._usesBrl() ? usd * Number(this._state.fx.usdBrl) : usd;
    }

    // Resumo do dia somando todas as contas; null se nenhuma tem custo estimado.
    _buildSummary(providers) {
        const usage = this._state?.usage ?? null;
        const priced = providers.filter(p => Number.isFinite(p.costTodayUsd));
        if (priced.length === 0 && !usage)
            return null;

        const today = {
            costUsd: priced.reduce((sum, p) => sum + p.costTodayUsd, 0),
            tokens: providers.reduce((sum, p) => sum + (Number.isFinite(p.tokensToday) ? p.tokensToday : 0), 0),
        };
        const period = PERIODS.find(([value]) => value === this._period) ?? PERIODS[0];
        const totals = (period[2] > 1 && usage?.[`last${period[2]}`]) || today;

        const card = new St.BoxLayout({
            style_class: 'tokenbar-card tokenbar-summary',
            style: `width: ${CONTENT_WIDTH}px;`,
            orientation: Clutter.Orientation.VERTICAL,
        });
        const top = new St.BoxLayout({style_class: 'tokenbar-card-head'});
        top.add_child(new St.Label({
            style_class: 'tokenbar-group-title',
            text: t('summary.title'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (usage) {
            const choice = makeChoice(localized(PERIODS), period[0], value => {
                this._period = value;
                this._queueRender();
            });
            choice.x_expand = true;
            choice.x_align = Clutter.ActorAlign.END;
            top.add_child(choice);
        }
        card.add_child(top);

        const row = new St.BoxLayout();
        row.add_child(new St.Label({style_class: 'tokenbar-big', text: this._money(totals.costUsd ?? 0)}));
        const side = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        side.add_child(new St.Label({
            style_class: 'tokenbar-muted tokenbar-small',
            text: t('tokens'),
            x_align: Clutter.ActorAlign.END,
        }));
        side.add_child(new St.Label({
            style_class: 'tokenbar-medium',
            text: formatTokens(totals.tokens ?? 0),
            x_align: Clutter.ActorAlign.END,
        }));
        row.add_child(side);
        card.add_child(row);

        const series = Array.isArray(usage?.series) ? usage.series : [];
        if (series.filter(day => day.tokens > 0).length > 1)
            card.add_child(makeChart(series, period[2]));

        // Meta de gasto: diária na visão "Hoje", de 30 dias na visão "30 dias".
        const budget = period[2] === 1 ? this._settings.get_int('budget-daily')
            : period[2] === 30 ? this._settings.get_int('budget-monthly') : 0;
        if (budget > 0) {
            const spent = this._inCurrency(totals.costUsd ?? 0);
            const share = Math.round(spent / budget * 100);
            const goal = new St.Label({
                style_class: `tokenbar-tiny ${share >= 100 ? 'tokenbar-pace-crit' : share >= 80 ? 'tokenbar-pace' : 'tokenbar-muted'}`,
                text: t('goal', {amount: `${this._currencySymbol()} ${formatAmount(budget)}`, pct: share}),
            });
            card.add_child(goal);
        }
        return card;
    }

    // Modelos e sessões de hoje de uma conta, mostrados ao abrir "detalhes".
    _buildDetails(provider) {
        const box = new St.BoxLayout({
            style_class: 'tokenbar-details',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const line = (name, item) => {
            const row = new St.BoxLayout({style_class: 'tokenbar-detail-row', x_expand: true});
            row.add_child(new St.Label({text: name, x_expand: true}));
            const parts = [formatTokens(item.tokens)];
            if (Number.isFinite(item.costUsd))
                parts.push(this._money(item.costUsd));
            row.add_child(new St.Label({style_class: 'tokenbar-muted', text: parts.join(' · ')}));
            return row;
        };
        // De onde vêm os tokens: a leitura de cache costuma ser quase tudo.
        const split = provider.tokensBreakdown;
        if (split && Number.isFinite(split.cacheRead)) {
            box.add_child(new St.Label({style_class: 'tokenbar-group-title', text: t('details.tokens')}));
            const part = (name, count) => {
                const row = new St.BoxLayout({style_class: 'tokenbar-detail-row', x_expand: true});
                row.add_child(new St.Label({text: name, x_expand: true}));
                row.add_child(new St.Label({style_class: 'tokenbar-muted', text: formatTokens(count)}));
                return row;
            };
            box.add_child(part(t('details.inOut'), (split.input || 0) + (split.output || 0)));
            box.add_child(part(t('details.cacheWrite'), split.cacheWrite || 0));
            box.add_child(part(t('details.cacheRead'), split.cacheRead || 0));
        }
        if (provider.costPartial) {
            const note = new St.Label({
                style_class: 'tokenbar-pace tokenbar-tiny',
                text: t('details.partialCost'),
            });
            note.clutter_text.line_wrap = true;
            box.add_child(note);
        }

        const models = Array.isArray(provider.modelsToday) ? provider.modelsToday : [];
        const sessions = Array.isArray(provider.sessionsToday) ? provider.sessionsToday : [];
        if (models.length > 0) {
            box.add_child(new St.Label({style_class: 'tokenbar-group-title', text: t('details.models')}));
            for (const model of models)
                box.add_child(line(model.model === 'unknown' ? t('unknownModel') : String(model.model).replace(/^claude-/, ''), model));
        }
        if (sessions.length > 0) {
            box.add_child(new St.Label({style_class: 'tokenbar-group-title', text: t('details.sessions')}));
            for (const session of sessions) {
                const row = line(session.project ? String(session.project) : t('noProject'), session);
                if (typeof session.path !== 'string' || !session.path) {
                    box.add_child(row);
                    continue;
                }
                const open = new St.Button({style_class: 'tokenbar-row-button', child: row, can_focus: true, x_expand: true});
                open.connect('clicked', () => {
                    this.menu.close();
                    openFolder(session.path);
                });
                box.add_child(open);
            }
        }
        return box;
    }

    _buildSection(provider, now) {
        const level = this._level(provider);
        const pct = worstPct(provider);

        const section = new St.BoxLayout({
            style_class: 'tokenbar-card',
            style: `width: ${CONTENT_WIDTH}px;`,
            orientation: Clutter.Orientation.VERTICAL,
        });

        // O cabeçalho é um botão: fechado, o cartão é só esta linha com o
        // percentual; aberto, mostra o resto.
        const expanded = this._settings.get_strv('expanded-providers').includes(provider.id);
        const head = new St.BoxLayout({style_class: 'tokenbar-card-head', x_expand: true});
        head.add_child(new St.Label({
            style_class: 'tokenbar-tag',
            text: provider.label ?? provider.id,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(new St.Label({
            style_class: 'tokenbar-name',
            text: provider.name ?? '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (!expanded && pct !== null) {
            const value = new St.Label({
                style_class: 'tokenbar-medium tokenbar-value',
                text: `${this._shown(pct)}%`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            setLevel(value, level);
            head.add_child(value);
        }
        const statusPill = new St.BoxLayout({
            style_class: 'tokenbar-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusPill.add_child(makeDot(level));
        statusPill.add_child(new St.Label({
            text: provider.plan ? String(provider.plan) : EMPTY,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(statusPill);
        head.add_child(new St.Icon({
            style_class: 'tokenbar-chevron',
            icon_name: expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const headButton = new St.Button({
            style_class: 'tokenbar-card-toggle',
            child: head,
            can_focus: true,
            x_expand: true,
        });
        headButton.connect('clicked', () => {
            const open = this._settings.get_strv('expanded-providers').filter(id => id !== provider.id);
            if (!expanded)
                open.push(provider.id);
            this._settings.set_strv('expanded-providers', open);
        });
        section.add_child(headButton);

        if (!expanded) {
            // Fechado, um erro de verdade ainda precisa aparecer.
            if (provider.error && !SOFT_STATUSES.includes(provider.status)) {
                const error = new St.Label({style_class: 'tokenbar-error', text: String(provider.error)});
                error.clutter_text.line_wrap = true;
                error.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                section.add_child(error);
            }
            return section;
        }

        // Número grande: a janela mais restritiva da conta.
        const hero = new St.BoxLayout({style_class: 'tokenbar-hero'});
        const big = new St.Label({
            style_class: 'tokenbar-big',
            text: pct === null ? EMPTY : `${this._shown(pct)}%`,
        });
        if (level === 'off')
            big.add_style_class_name('tokenbar-muted');
        hero.add_child(big);
        if (pct !== null) {
            hero.add_child(new St.Label({
                style_class: 'tokenbar-muted tokenbar-small tokenbar-big-caption',
                text: this._settings.get_boolean('show-remaining') ? t('remaining') : t('used'),
                y_align: Clutter.ActorAlign.END,
            }));
        }
        if (Number.isFinite(provider.tokensToday)) {
            const today = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
            });
            today.add_child(new St.Label({
                style_class: 'tokenbar-muted tokenbar-small',
                text: t('tokens.today'),
                x_align: Clutter.ActorAlign.END,
            }));
            today.add_child(new St.Label({
                style_class: 'tokenbar-medium',
                text: formatTokens(provider.tokensToday),
                x_align: Clutter.ActorAlign.END,
            }));
            if (Number.isFinite(provider.costTodayUsd)) {
                today.add_child(new St.Label({
                    style_class: 'tokenbar-muted tokenbar-small',
                    text: `≈ ${this._money(provider.costTodayUsd)}`,
                    x_align: Clutter.ActorAlign.END,
                }));
            }
            hero.add_child(today);
        }
        section.add_child(hero);

        // Janelas agrupadas (ex.: Gemini, Claude/GPT no Antigravity) ganham um
        // subtítulo; dentro de cada grupo elas ficam em duas colunas.
        const groups = new Map();
        for (const window of windowsOf(provider)) {
            const key = typeof window.group === 'string' ? window.group : '';
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(window);
        }
        for (const [name, windows] of groups) {
            if (name)
                section.add_child(new St.Label({style_class: 'tokenbar-group-title', text: name}));
            for (let i = 0; i < windows.length; i += 2) {
                const pair = windows.slice(i, i + 2);
                const width = pair.length === 2 ? (CONTENT_WIDTH - COLUMN_GAP) / 2 : CONTENT_WIDTH;
                const row = new St.BoxLayout({style: `spacing: ${COLUMN_GAP}px;`});
                const levels = pair.map(window => (level === 'off' ? 'off' : this._pctLevel(window.usedPct)));
                const reservePace = pair.some((window, index) => paceOf(window, levels[index], now) !== null);
                pair.forEach((window, index) => {
                    row.add_child(this._buildWindow(window, levels[index], now, width, reservePace));
                });
                section.add_child(row);
            }
        }

        if (provider.error) {
            const error = new St.Label({
                style_class: SOFT_STATUSES.includes(provider.status) ? 'tokenbar-muted tokenbar-small' : 'tokenbar-error',
                text: provider.status === 'rate_limited'
                    ? t('lastValue', {text: provider.error})
                    : String(provider.error),
            });
            error.clutter_text.line_wrap = true;
            error.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            section.add_child(error);
        }

        if (provider.tokensBreakdown || provider.modelsToday?.length > 0 || provider.sessionsToday?.length > 0) {
            const open = this._expanded.has(provider.id);
            if (open)
                section.add_child(this._buildDetails(provider));
            const toggle = new St.Button({
                style_class: 'tokenbar-ghost',
                label: open ? t('details.hide') : t('details.show'),
                can_focus: true,
                x_expand: true,
            });
            toggle.connect('clicked', () => {
                if (open)
                    this._expanded.delete(provider.id);
                else
                    this._expanded.add(provider.id);
                this._queueRender();
            });
            section.add_child(toggle);
        }
        return section;
    }

    _buildWindow(window, level, now, width, reservePace) {
        const box = new St.BoxLayout({
            style_class: 'tokenbar-window',
            style: `width: ${width}px;`,
            orientation: Clutter.Orientation.VERTICAL,
        });

        const shown = this._shown(window.usedPct);
        const row = new St.BoxLayout({style_class: 'tokenbar-window-text'});
        row.add_child(new St.Label({
            style_class: 'tokenbar-muted',
            text: String(window.label ?? window.kind ?? ''),
            y_align: Clutter.ActorAlign.END,
        }));
        row.add_child(new St.Label({
            style_class: 'tokenbar-medium',
            text: `${shown}%`,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        }));
        box.add_child(row);

        // Qualquer uso acima de zero acende pelo menos um bloco.
        const filled = shown <= 0
            ? 0
            : Math.min(SEGMENTS, Math.max(1, Math.round(shown / (100 / SEGMENTS))));
        const segmentWidth = Math.floor((width - SEGMENT_GAP * (SEGMENTS - 1)) / SEGMENTS);
        const meter = new St.BoxLayout({style: `spacing: ${SEGMENT_GAP}px;`});
        for (let i = 0; i < SEGMENTS; i++) {
            const segment = new St.Widget({
                style_class: 'tokenbar-segment',
                style: `width: ${segmentWidth}px;`,
            });
            if (i < filled)
                setLevel(segment, level);
            meter.add_child(segment);
        }
        box.add_child(meter);

        box.add_child(new St.Label({
            style_class: 'tokenbar-muted tokenbar-tiny',
            text: formatReset(window.resetsAt, now) || ' ',
        }));

        // Linha de ritmo: se a vizinha tem e esta não, fica vazia para alinhar.
        if (reservePace) {
            const pace = paceOf(window, level, now);
            box.add_child(new St.Label({
                style_class: pace ? `tokenbar-tiny ${pace.styleClass}` : 'tokenbar-tiny',
                text: pace ? pace.text : ' ',
            }));
        }
        return box;
    }

    _onMenuToggled(open) {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (!open) {
            if (this._view !== 'main')
                this._setView('main');
            return;
        }
        this._fitToScreen();
        this._renderPopup();
        this._load();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, OPEN_TICK_SECONDS, () => {
            this._renderPopup();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Limita a área rolável ao que sobra na tela onde a barra está.
    _fitToScreen() {
        const monitor = Main.layoutManager.findIndexForActor(this);
        const area = Main.layoutManager.getWorkAreaForMonitor(Math.max(monitor, 0));
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const room = Math.floor(area.height / scale) - POPUP_CHROME_HEIGHT;
        this._scroll.style = `max-height: ${Math.max(room, 200)}px;`;
    }

    async _refresh(mode = '--once') {
        if (this._refreshing || this._destroyed)
            return;
        this._refreshing = true;
        this._refreshButton.label = t('refreshing');
        this._refreshButton.reactive = false;
        let failed = false;
        try {
            const argv = this._extension.collectorCommand([mode]);
            if (!argv)
                throw new Error('no collector');
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            await proc.wait_async(this._cancellable);
            failed = !proc.get_successful();
        } catch {
            failed = true;
        }
        if (this._destroyed)
            return;
        this._refreshing = false;
        this._refreshButton.label = failed ? t('refresh.failed') : t('refresh');
        this._refreshButton.reactive = true;
        await this._load();
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        for (const id of [this._debounceId, this._pollId, this._tickId, this._renderId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._debounceId = this._pollId = this._tickId = this._renderId = 0;
        if (this._monitor) {
            this._monitor.disconnectObject(this);
            this._monitor.cancel();
            this._monitor = null;
        }
        this._settings.disconnectObject(this);
        this._settings = null;
        this.menu.disconnectObject(this);
        super.destroy();
    }
});
