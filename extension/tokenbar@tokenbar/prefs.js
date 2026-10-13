import Adw from 'gi://Adw';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {resolveLanguage, setLanguage, t} from './lib/i18n.js';

// As configurações ficam dentro do próprio painel. Esta janela existe só para
// quem chega pelo app Extensões saber onde elas estão.
export default class TokenBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        setLanguage(resolveLanguage(this.getSettings().get_string('language'), GLib.get_language_names()));
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        group.add(new Adw.StatusPage({
            icon_name: 'preferences-system-symbolic',
            title: t('prefs.title'),
            description: t('prefs.body'),
        }));
        page.add(group);
        window.add(page);
    }
}
