"""Testes da bandeja (python3 -m unittest discover -s tests -p 'test_*.py')."""

import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location('tokenbar_tray', os.path.join(HERE, '..', 'tray', 'tokenbar_tray.py'))
tray = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tray)

NOW = 1_800_000_000.0


def iso(offset):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(NOW + offset, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


STATE = {
    'updatedAt': iso(-40),
    'fx': {'usdBrl': 5.0},
    'update': {'available': True, 'latest': 'e4f5a6b', 'url': 'https://example.invalid/compare'},
    'providers': [
        {'id': 'claude-main', 'label': 'CLD', 'name': 'Claude', 'status': 'ok',
         'windows': [{'kind': 'session', 'label': '5h', 'usedPct': 38, 'resetsAt': iso(2 * 3600 + 14 * 60)},
                     {'kind': 'weekly', 'label': 'Semana', 'usedPct': 12, 'resetsAt': iso(5 * 86400)}],
         'tokensToday': 84_300_000, 'costTodayUsd': 24.6, 'error': None},
        {'id': 'claude-2', 'label': 'CLD2', 'name': 'Claude (work)', 'status': 'ok',
         'windows': [{'kind': 'session', 'label': '5h', 'usedPct': 91, 'resetsAt': None}],
         'tokensToday': 1500, 'costTodayUsd': 0.4, 'error': None},
        {'id': 'antigravity', 'label': 'AG', 'name': 'Antigravity', 'status': 'idle',
         'windows': [{'kind': 'session', 'group': 'Gemini', 'label': '5h', 'usedPct': 10, 'resetsAt': None}],
         'tokensToday': None, 'costTodayUsd': None, 'error': 'Antigravity fechado'},
        {'id': 'codex', 'label': 'OAI', 'name': 'Codex', 'status': 'unauthorized', 'windows': [], 'error': 'login expirado'},
    ],
}

PT = {'language': 'pt', 'show_remaining': True, 'warn': 60, 'crit': 85, 'currency': 'brl', 'label': 'critical'}


class TextTests(unittest.TestCase):
    def test_numbers_and_money_per_language(self):
        pt, en = tray.Text('pt'), tray.Text('en')
        self.assertEqual(pt.tokens(84_300_000), '84,3M')
        self.assertEqual(en.tokens(84_300_000), '84.3M')
        self.assertEqual(pt.tokens(1000), '1k')
        self.assertEqual(pt.money(1234.5, {'usdBrl': 2}, 'brl'), 'R$ 2.469,00')
        self.assertEqual(en.money(1234.5, None, 'brl'), '$ 1,234.50', 'sem cotação cai para dólar')
        self.assertEqual(pt.money(3, None, 'usd'), 'US$ 3,00')

    def test_durations_and_resets(self):
        pt = tray.Text('pt')
        self.assertEqual(pt.reset(iso(2 * 3600 + 14 * 60), NOW), 'reseta em 2h 14min')
        self.assertEqual(pt.reset(iso(3 * 86400 + 4 * 3600), NOW), 'reseta em 3d 4h')
        self.assertEqual(pt.reset(iso(-60), NOW), 'reseta em instantes')
        self.assertEqual(pt.reset(None, NOW), '')
        self.assertEqual(tray.Text('en').reset(iso(14 * 60), NOW), 'resets in 14min')

    def test_system_language(self):
        self.assertEqual(tray.system_language({'LANG': 'pt_BR.UTF-8'}), 'pt')
        self.assertEqual(tray.system_language({'LANG': 'pt_BR.UTF-8', 'LC_ALL': 'C'}), 'en')
        self.assertEqual(tray.system_language({}), 'en')

    def test_every_string_has_both_languages(self):
        for key, entry in tray.STRINGS.items():
            self.assertEqual(len(entry), 2, key)
            self.assertTrue(all(text.strip() for text in entry), key)


class ViewTests(unittest.TestCase):
    def view(self, **options):
        return tray.View(STATE, {**PT, **options}, now=NOW)

    def test_label_shows_the_most_critical_account(self):
        self.assertEqual(self.view().label(), 'CLD2 9%')
        self.assertEqual(self.view(show_remaining=False).label(), 'CLD2 91%')
        self.assertEqual(self.view(label='all').label(), 'CLD 62%  CLD2 9%  AG 90%')
        self.assertEqual(self.view(label='none').label(), '')
        self.assertEqual(self.view().overall_level(), 'crit')
        self.assertAlmostEqual(self.view().ring_fraction(), 0.09)

    def test_header_tooltip_and_account_lines(self):
        view = self.view()
        self.assertEqual(view.header(), 'TokenBar · atualizado há 40 s')
        self.assertIn('Codex: — — login expirado', view.tooltip())
        self.assertEqual(view.account_lines(STATE['providers'][0]), [
            '5h: 62% · reseta em 2h 14min',
            'Semana: 88% · reseta em 5d 0h',
            'tokens hoje: 84,3M ≈ R$ 123,00',
        ])
        self.assertEqual(view.account_lines(STATE['providers'][2]), ['Gemini 5h: 90%', 'Antigravity fechado'])
        self.assertEqual(view.summary(), 'uso hoje: R$ 125,00 · 84,3M tokens (preço de API)')
        self.assertEqual(view.update_line(), 'Atualização disponível: e4f5a6b')

    def test_missing_or_stale_state(self):
        self.assertEqual(tray.View(None, PT, now=NOW).header(), 'sem dados — o coletor ainda não gravou state.json')
        self.assertEqual(tray.View(None, PT, now=NOW).label(), '—')
        stale = {**STATE, 'updatedAt': iso(-3600)}
        self.assertEqual(tray.View(stale, PT, now=NOW).header(), 'dados desatualizados — coletor parado?')


class IconAndMenuTests(unittest.TestCase):
    def test_ring_pixmap_is_argb_in_network_order(self):
        width, height, data = tray.ring_pixmap(22, 0.25, 'ok')
        self.assertEqual((width, height, len(data)), (22, 22, 22 * 22 * 4))
        # Topo do anel (preenchido no começo do arco) na cor verde, opaco.
        top = (1 * 22 + 11) * 4
        self.assertGreater(data[top], 200)
        self.assertEqual(tuple(data[top + 1:top + 4]), tray.COLORS['ok'])
        # Centro vazio.
        center = (11 * 22 + 11) * 4
        self.assertEqual(data[center], 0)
        # Lado esquerdo (fora do arco de 25%): trilho grafite, como no logo.
        left = (11 * 22 + 1) * 4
        self.assertEqual(tuple(data[left + 1:left + 4]), tray.TRACK)

    def test_ring_pixmap_writes_the_number_inside(self):
        for size in (16, 22, 48):
            _, _, data = tray.ring_pixmap(size, 0.62, 'ok', 62)
            pixel = lambda x, y: tuple(data[(y * size + x) * 4:(y * size + x) * 4 + 4])
            colours = {pixel(x, y)[1:] for x in range(size) for y in range(size) if pixel(x, y)[0] == 255}
            # Miolo escuro e algarismos na cor do nível, sem encostar no anel.
            self.assertIn(tray.DISC, colours)
            mask = tray.number_mask('62', size)
            self.assertTrue(mask)
            self.assertTrue(all(pixel(x, y)[1:] == tray.COLORS['ok'] for x, y in mask))
            inner = size / 2 - 0.5 - max(1.5, size * 0.12)
            centre = (size - 1) / 2
            self.assertTrue(all(((x - centre) ** 2 + (y - centre) ** 2) ** 0.5 < inner for x, y in mask))
        self.assertTrue(tray.number_mask('100', 16))

    def test_menu_tree_ids_and_actions(self):
        calls = []
        actions = {name: (lambda name=name: calls.append(name)) for name in ('refresh', 'update', 'site', 'code', 'quit')}
        root, items = tray.build_menu(tray.View(STATE, PT, now=NOW), actions)
        self.assertEqual(root.id, 0)
        self.assertEqual(sorted(items), list(range(len(items))))
        # Os números ficam fixos entre atualizações, mesmo com itens entrando e saindo.
        ids = tray.MenuIds()
        _, first = tray.build_menu(tray.View(STATE, PT, now=NOW), actions, ids)
        without_update = {**STATE, 'update': None}
        _, second = tray.build_menu(tray.View(without_update, {**PT, 'language': 'en'}, now=NOW), actions, ids)
        by_key = lambda numbered: {item.key: item_id for item_id, item in numbered.items()}
        for key, item_id in by_key(second).items():
            self.assertEqual(by_key(first).get(key, item_id), item_id, key)
        self.assertNotIn('update', by_key(second))
        labels = [item.label for item in root.children if not item.separator]
        self.assertEqual(labels[0], 'TokenBar · atualizado há 40 s')
        self.assertIn('⬆ Atualização disponível: e4f5a6b', labels)
        self.assertIn('🔴 CLD2 · Claude (work) — 9%', labels)
        self.assertEqual(labels[-3:], ['Atualizar agora', 'Sobre o TokenBar', 'Sair'])
        refresh = next(item for item in items.values() if item.label == 'Atualizar agora')
        refresh.action()
        self.assertEqual(calls, ['refresh'])
        about = next(item for item in items.values() if item.label == 'Sobre o TokenBar')
        self.assertEqual([child.label for child in about.children], ['Site do autor (Diogo Brito)', 'Código no GitHub'])
        self.assertEqual(about.properties()['children-display'].unpack(), 'submenu')


class OptionsTests(unittest.TestCase):
    def test_defaults_and_overrides_from_config(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'config.json')
            self.assertEqual(tray.load_options(path)['label'], 'critical')
            with open(path, 'w', encoding='utf-8') as file:
                json.dump({'language': 'en', 'bar': {'showRemaining': False, 'warn': 50, 'crit': 70, 'label': 'all'}}, file)
            options = tray.load_options(path)
            self.assertEqual(options, {
                'language': 'en', 'show_remaining': False, 'warn': 50, 'crit': 70,
                'currency': 'usd', 'label': 'all', 'hidden_providers': [], 'provider_order': [],
                'dock': False, 'notifications': True, 'update_check': True,
                'budget_daily': 0, 'budget_monthly': 0,
            })
            with open(path, 'w', encoding='utf-8') as file:
                file.write('{ quebrado')
            self.assertEqual(tray.load_options(path)['warn'], 60)


if __name__ == '__main__':
    unittest.main()
