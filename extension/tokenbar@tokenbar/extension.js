import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TokenBarIndicator} from './indicator.js';
import {formatAmount, formatReset, windowsOf} from './lib/format.js';
import {getLanguage, resolveLanguage, setLanguage, t} from './lib/i18n.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

// Espera antes de reabrir o painel depois de recriar o indicador.
const REOPEN_DELAY_MS = 150;
// Se o coletor embutido sair sozinho, espera isto antes de subir de novo.
const EMBEDDED_RESTART_S = 60;

export default class TokenBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._recreateId = 0;
        this._reopenId = 0;
        // Por janela: se estava acima do vermelho e com quanto, na última coleta.
        this._alerts = new Map();
        this._statuses = new Map();
        this._budgetDay = null;
        this._alertStamp = null;

        Main.wm.addKeybinding('toggle-panel', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator?.menu.toggle());
        this._settings.connectObject(
            'changed::panel-position', () => this._queueRecreate(),
            'changed::panel-index', () => this._queueRecreate(),
            'changed::language', () => this._applyLanguage(true),
            'changed::collector-interval', () => this._writeCollectorConfig(),
            'changed::update-check', () => this._writeCollectorConfig(),
            'changed::disabled-providers', () => this._writeCollectorConfig(),
            this);
        this._applyLanguage(false);
        this._writeCollectorConfig();
        this._recreate();
        this._startEmbeddedCollector();
    }

    // Idioma: 'auto' segue o sistema. Ao trocar com a extensão rodando, o
    // painel é refeito e o coletor roda de novo para regravar os textos dele.
    _applyLanguage(changed) {
        setLanguage(resolveLanguage(this._settings.get_string('language'), GLib.get_language_names()));
        if (!changed)
            return;
        this._languageChanged = true;
        this._writeCollectorConfig();
        this._queueRecreate();
    }

    // A troca de posição pode vir de um botão do próprio painel; recriar o
    // indicador só no próximo ciclo evita destruí-lo no meio do clique.
    _queueRecreate() {
        if (this._recreateId)
            return;
        this._recreateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._recreateId = 0;
            this._recreate();
            return GLib.SOURCE_REMOVE;
        });
    }

    _recreate() {
        const reopenSettings = this._indicator?.settingsOpen ?? false;
        this._indicator?.destroy();
        this._indicator = new TokenBarIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
        // O item novo ainda não tem lugar na barra neste instante; o painel
        // só reabre depois de ele ser posicionado.
        if (this._languageChanged) {
            this._languageChanged = false;
            this._indicator.refreshNow();
        }
        if (reopenSettings) {
            this._clearReopen();
            this._reopenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REOPEN_DELAY_MS, () => {
                this._reopenId = 0;
                this._indicator?.openSettings();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearReopen() {
        if (this._reopenId)
            GLib.source_remove(this._reopenId);
        this._reopenId = 0;
    }

    // Avisa quando uma janela cruza o limite vermelho e quando ela libera
    // depois disso. A primeira leitura só registra o estado, sem avisar.
    checkAlerts(state) {
        if (!this._settings || !state || state.updatedAt === this._alertStamp)
            return;
        const first = this._alertStamp === null;
        this._alertStamp = state.updatedAt;
        const enabled = this._settings.get_boolean('notifications');
        const crit = Math.max(this._settings.get_int('crit-threshold'), this._settings.get_int('warn-threshold'));
        const now = Date.now();

        const providers = Array.isArray(state.providers) ? state.providers.filter(p => p && p.id) : [];

        // Versão nova: um aviso por versão, lembrado entre sessões.
        const update = state.update;
        if (enabled && update?.available && update.latest && this._settings.get_string('update-notified') !== update.latest) {
            this._settings.set_string('update-notified', update.latest);
            Main.notify(t('notify.update'), [update.latest, update.summary].filter(Boolean).join(' · '));
        }

        // Conta que perdeu o login desde a última coleta.
        for (const provider of providers) {
            const before = this._statuses.get(provider.id);
            this._statuses.set(provider.id, provider.status);
            if (!first && enabled && before && before !== 'unauthorized' && provider.status === 'unauthorized')
                Main.notify(t('notify.loginExpired', {account: provider.label ?? provider.id}), String(provider.error ?? ''));
        }

        // Meta diária: um aviso por dia, ao passar de 100%.
        const budget = this._settings.get_int('budget-daily');
        const rate = Number(state.fx?.usdBrl);
        const brl = this._settings.get_string('currency') === 'brl' && Number.isFinite(rate) && rate > 0;
        const spentUsd = providers.reduce((sum, p) => sum + (Number.isFinite(p.costTodayUsd) ? p.costTodayUsd : 0), 0);
        const spent = brl ? spentUsd * rate : spentUsd;
        const day = new Date().toDateString();
        if (budget > 0 && spent >= budget && this._budgetDay !== day) {
            this._budgetDay = day;
            if (!first && enabled) {
                const symbol = brl ? 'R$' : getLanguage() === 'pt' ? 'US$' : '$';
                Main.notify(t('notify.goalHit'), t('notify.goalBody', {
                    spent: `${symbol} ${formatAmount(spent)}`,
                    goal: `${symbol} ${formatAmount(budget)}`,
                }));
            }
        }

        for (const provider of providers) {
            if (provider?.status !== 'ok')
                continue;
            for (const window of windowsOf(provider)) {
                const key = `${provider.id}/${window.group ?? ''}/${window.label ?? window.kind}`;
                const before = this._alerts.get(key);
                const over = window.usedPct > crit;
                this._alerts.set(key, {over, pct: window.usedPct});
                if (first || !enabled || !before || before.over === over)
                    continue;
                const name = [provider.label ?? provider.id, window.group, window.label].filter(Boolean).join(' · ');
                if (over) {
                    const reset = formatReset(window.resetsAt, now);
                    Main.notify(t('notify.over', {name, pct: window.usedPct}),
                        reset ? t('notify.overBodyReset', {crit, reset}) : t('notify.overBody', {crit}));
                } else if (window.usedPct < before.pct) {
                    Main.notify(t('notify.freed', {name}), t('notify.freedBody', {pct: window.usedPct}));
                }
            }
        }
    }

    // O coletor não fala com o GSettings: intervalo e contas desligadas são
    // espelhados em ~/.config/tokenbar/config.json, que ele relê a cada ciclo.
    async _writeCollectorConfig() {
        const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'tokenbar']);
        const config = {
            intervalSec: this._settings.get_int('collector-interval'),
            disabledProviders: this._settings.get_strv('disabled-providers'),
            // O coletor escreve erros e rótulos no mesmo idioma da interface.
            language: getLanguage(),
            updateCheck: this._settings.get_boolean('update-check'),
        };
        try {
            GLib.mkdir_with_parents(dir, 0o700);
            const bytes = new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`));
            await Gio.File.new_for_path(GLib.build_filenamev([dir, 'config.json']))
                .replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            console.error(`tokenbar: could not write config.json: ${error.message}`);
        }
    }

    // Como rodar o coletor: o serviço em Node, se o install.sh o instalou;
    // senão, o coletor em GJS que vem dentro da extensão (é o caso de quem
    // instala pelo extensions.gnome.org, sem Node nem systemd).
    collectorCommand(args) {
        const service = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'tokenbar-collector']);
        if (GLib.file_test(service, GLib.FileTest.IS_EXECUTABLE))
            return [service, ...args];
        const gjs = GLib.find_program_in_path('gjs');
        const script = this.dir.get_child('collector').get_child('gjs').get_child('tokenbar-collector.js');
        if (gjs && script.query_exists(null))
            return [gjs, '-m', script.get_path(), ...args];
        return null;
    }

    get usesEmbeddedCollector() {
        return this.collectorCommand([])?.[1] === '-m';
    }

    // Sem o serviço do systemd, o coletor embutido roda como processo filho
    // enquanto a extensão estiver ligada.
    _startEmbeddedCollector() {
        this._embeddedRestartId = 0;
        if (!this.usesEmbeddedCollector || GLib.getenv('TOKENBAR_TEST_NO_COLLECTOR'))
            return;
        try {
            // A entrada padrão fica ligada a nós: se o gnome-shell sair sem
            // desligar a extensão (queda, por exemplo), ela fecha e o coletor
            // encerra sozinho em vez de ficar órfão.
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE});
            launcher.setenv('TOKENBAR_EXIT_WITH_PARENT', '1', true);
            this._embedded = launcher.spawnv(this.collectorCommand([]));
        } catch (error) {
            console.error(`tokenbar: could not start the collector: ${error.message}`);
            return;
        }
        const process = this._embedded;
        process.wait_async(null).then(() => {
            if (this._embedded !== process)
                return;
            this._embedded = null;
            this._embeddedRestartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, EMBEDDED_RESTART_S, () => {
                this._startEmbeddedCollector();
                return GLib.SOURCE_REMOVE;
            });
        }).catch(() => {});
    }

    _stopEmbeddedCollector() {
        if (this._embeddedRestartId)
            GLib.source_remove(this._embeddedRestartId);
        this._embeddedRestartId = 0;
        const process = this._embedded;
        this._embedded = null;
        process?.send_signal(15);
    }

    disable() {
        this._stopEmbeddedCollector();
        if (this._recreateId) {
            GLib.source_remove(this._recreateId);
            this._recreateId = 0;
        }
        this._clearReopen();
        Main.wm.removeKeybinding('toggle-panel');
        this._alerts = null;
        this._statuses = null;
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
