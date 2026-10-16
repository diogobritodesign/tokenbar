#!/usr/bin/env python3
"""Janela do TokenBar para desktops sem a extensão do GNOME.

Reproduz o painel da extensão (mesmas cores, espaçamentos, fonte, cartões,
anéis e medidores em blocos) com GTK 4, para o visual ser o mesmo em KDE,
Xfce, Cinnamon e afins. Abre pelo clique no ícone de bandeja.

    python3 tokenbar_window.py   # abre a janela sozinha (útil para testar)
"""

import json
import math
import os
import subprocess
import sys
import time

import ctypes
import gi

# O gtk4-layer-shell (KDE e compositores wlroots: fixa o painel no canto) só
# funciona se for carregado antes do GTK falar com o Wayland.
try:
    ctypes.CDLL('libgtk4-layer-shell.so.0', mode=ctypes.RTLD_GLOBAL)
    gi.require_version('Gtk4LayerShell', '1.0')
    from gi.repository import Gtk4LayerShell as LayerShell  # noqa: E402
except (OSError, ImportError, ValueError):
    LayerShell = None

gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gio, GLib, GObject, Gtk  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tokenbar_tray as core  # noqa: E402

CONTENT_WIDTH = 356
COLUMN_GAP = 14
SEGMENTS = 10
SEGMENT_GAP = 3
PACE_MIN_PCT = 5
PACE_MIN_ELAPSED = 0.05

# Os mesmos valores de extension/tokenbar@tokenbar/stylesheet.css.
CSS = """
window.tokenbar { background: transparent; }
.surface {
  border-radius: 26px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background-color: rgba(15, 15, 16, 0.94);
  font-family: "Geist Mono", "SF Mono", "Adwaita Mono", monospace;
  font-size: 12px;
  font-feature-settings: "tnum";
  color: #ffffff;
}
.popup { padding: 12px; }
.header { padding: 6px 4px 0 8px; }
.title { font-size: 15px; font-weight: 600; }
.pill { padding: 4px 10px; border-radius: 12px; background-color: rgba(255, 255, 255, 0.07); font-size: 11px; }
.dot { min-width: 8px; min-height: 8px; border-radius: 4px; background-color: #6b6b70; }
.dot.ok { background-color: #7bea83; } .dot.warn { background-color: #ece38f; }
.dot.crit { background-color: #ff7b72; } .dot.off { background-color: #6b6b70; }
.muted { color: #8e8e93; }
.small, .tiny { font-size: 11px; }
.medium { font-size: 14px; }
.value.ok { color: #7bea83; } .value.warn { color: #ece38f; } .value.crit { color: #ff7b72; } .value.off { color: #8e8e93; }
.card {
  padding: 12px 16px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  background-color: rgba(34, 34, 37, 0.72);
}
.tag { padding: 4px 8px; border-radius: 8px; background-color: #ffffff; color: #0f0f10; font-size: 10px; font-weight: 700; }
.name { font-size: 13px; }
.big { font-size: 34px; font-weight: 300; }
.big-caption { padding-bottom: 7px; }
.group-title { font-size: 11px; font-weight: 500; color: #a97cf8; }
.segment { min-height: 12px; border-radius: 4px; background-color: rgba(255, 255, 255, 0.08); }
.segment.ok { background-color: #7bea83; } .segment.warn { background-color: #ece38f; }
.segment.crit { background-color: #ff7b72; } .segment.off { background-color: #6b6b70; }
.pace { color: #ece38f; } .pace-crit { color: #ff7b72; }
.error { font-size: 11px; color: #ff7b72; }
.warning { padding: 10px 14px; border-radius: 14px; background-color: rgba(236, 227, 143, 0.12); font-size: 11px; color: #ece38f; }
.update { padding: 10px 14px; border-radius: 14px; background-color: rgba(169, 124, 248, 0.16); }
.update-title { font-weight: 600; color: #c4a6fb; }
.detail-row { padding: 4px 6px; font-size: 11px; }
button.flat-row { padding: 0; border-radius: 10px; background: none; box-shadow: none; border: none; min-height: 0; }
button.flat-row:hover .name { color: #d9c8fd; }
button.flat-row:hover .chevron { color: #ffffff; }
.chevron { color: #6b6b70; font-size: 11px; }
button.ghost { padding: 7px 12px; border-radius: 12px; background-color: rgba(255, 255, 255, 0.04); color: #8e8e93; font-size: 11px; border: none; box-shadow: none; }
button.ghost:hover { background-color: rgba(255, 255, 255, 0.09); color: #ffffff; }
.segmented { padding: 4px; border-radius: 18px; background-color: rgba(34, 34, 37, 0.72); }
.choice { padding: 3px; border-radius: 13px; background-color: rgba(15, 15, 16, 0.55); }
button.tb { padding: 9px 12px; border-radius: 14px; color: #c7c7cc; font-size: 12px; background: none; border: none; box-shadow: none; min-height: 0; }
button.tb.small { padding: 6px 8px; border-radius: 10px; font-size: 11px; }
button.tb.primary { background-color: rgba(255, 255, 255, 0.1); color: #ffffff; }
button.tb:hover { background-color: rgba(255, 255, 255, 0.14); color: #ffffff; }
button.tb:active { background-color: #a97cf8; color: #0f0f10; }
button.step { min-width: 24px; min-height: 24px; padding: 0; border-radius: 12px; background-color: rgba(255, 255, 255, 0.1); color: #ffffff; border: none; box-shadow: none; }
button.step:hover { background-color: rgba(255, 255, 255, 0.18); }
.account-row { border-radius: 10px; padding: 2px 0; }
.account-row.drop-hover { background-color: rgba(169, 124, 248, 0.18); }
.account-row.dragging { opacity: 0.55; }
switch { border-radius: 13px; background-color: rgba(255, 255, 255, 0.12); border: none; min-height: 20px; }
switch:checked { background-color: #a97cf8; }
switch slider { min-width: 14px; min-height: 14px; border-radius: 7px; background-color: #8e8e93; box-shadow: none; border: none; margin: 3px; }
switch:checked slider { background-color: #ffffff; }
scrolledwindow, viewport { background: transparent; }
/* O tema do GTK não pode vazar: botões sem fundo, borda nem cor próprios. */
.surface button { background-image: none; outline: none; text-shadow: none; -gtk-icon-shadow: none; }
.surface button.flat-row, .surface button.flat-row label { color: #ffffff; }
.surface button.flat-row .muted { color: #8e8e93; }
.surface button.flat-row .value.ok { color: #7bea83; } .surface button.flat-row .value.warn { color: #ece38f; }
.surface button.flat-row .value.crit { color: #ff7b72; } .surface button.flat-row .value.off { color: #8e8e93; }
.surface button.flat-row .tag { color: #0f0f10; }
.surface button.flat-row .chevron { color: #6b6b70; }
.surface button.ghost, .surface button.ghost label { color: #8e8e93; }
.surface button.ghost:hover, .surface button.ghost:hover label { color: #ffffff; }
.surface button.tb label { color: inherit; }
"""

WINDOW_STRINGS = {
    'updated': ('atualizado há {age}', 'updated {age} ago'),
    'no_data': ('sem dados — o coletor ainda não gravou state.json', 'no data — the collector has not written state.json yet'),
    'stale': ('dados desatualizados — coletor parado?', 'stale data — is the collector running?'),
    'no_accounts': ('nenhuma conta encontrada ou habilitada', 'no account found or enabled'),
    'incident': ('{name} com instabilidade: {text}', '{name} is having issues: {text}'),
    'summary': ('Uso · preço de API', 'Usage · API prices'),
    'today': ('Hoje', 'Today'), 'days7': ('7 dias', '7 days'), 'days30': ('30 dias', '30 days'),
    'tokens': ('tokens', 'tokens'), 'tokens_today': ('tokens hoje', 'tokens today'),
    'remaining': ('restante', 'left'), 'used': ('usado', 'used'),
    'week': ('Semana', 'Week'),
    'pace_out': ('esgota em ~{time}', 'runs out in ~{time}'), 'pace_full': ('limite atingido', 'limit reached'),
    'last_value': ('{text} — mostrando o último valor', '{text} — showing the last known value'),
    'details_show': ('tokens, modelos e sessões de hoje', 'tokens, models and sessions today'),
    'details_hide': ('ocultar detalhes', 'hide details'),
    'd_tokens': ('Tokens hoje', 'Tokens today'), 'd_inout': ('entrada + saída', 'input + output'),
    'd_write': ('escrita de cache', 'cache writes'), 'd_read': ('leitura de cache', 'cache reads'),
    'd_models': ('Modelos hoje', 'Models today'), 'd_sessions': ('Sessões hoje', 'Sessions today'),
    'no_project': ('sem projeto', 'no project'),
    'partial': ('custo parcial: há uso de modelo sem preço na tabela', 'partial cost: some usage is from a model with no price in the table'),
    'update_title': ('Atualização disponível', 'Update available'),
    'update_how': ('para atualizar: git pull && ./install.sh', 'to update: git pull && ./install.sh'),
    'update_auto': ('Um clique baixa e instala a versão nova.', 'One click downloads and installs the new version.'),
    'update_now': ('Atualizar agora', 'Update now'),
    'update_running': ('Baixando e instalando…', 'Downloading and installing…'),
    'update_done': ('Pronto! A bandeja já reiniciou com a versão nova.', 'Done! The tray icon restarted with the new version.'),
    'update_failed': ('Não deu para atualizar sozinho. No terminal, na pasta do TokenBar: git pull && ./install.sh',
                      'Could not update automatically. In a terminal, in the TokenBar folder: git pull && ./install.sh'),
    'update_view': ('Ver novidades', 'See what changed'),
    'refresh': ('Atualizar', 'Refresh'), 'refreshing': ('Atualizando…', 'Refreshing…'),
    'refresh_failed': ('Falhou — tentar de novo', 'Failed — try again'),
    'settings': ('Configurações', 'Settings'), 'back': ('Voltar', 'Back'),
    's_accounts': ('Contas', 'Accounts'), 's_collect': ('coletar', 'collect'),
    's_drag': ('Arraste para reordenar', 'Drag to reorder'),
    's_display': ('Exibição', 'Display'), 's_language': ('Idioma', 'Language'),
    'lang_auto': ('Sistema', 'System'), 'lang_pt': ('Português', 'Português'), 'lang_en': ('English', 'English'),
    's_percent': ('Percentuais', 'Percentages'), 'pct_left': ('Restante', 'Left'), 'pct_used': ('Usado', 'Used'),
    's_currency': ('Moeda do custo', 'Cost currency'), 'brl': ('Reais (R$)', 'Reais (R$)'), 'usd': ('Dólares (US$)', 'Dollars ($)'),
    's_dock': ('Ícone na barra de baixo (só a logo)', 'Icon in the bottom bar (logo only)'),
    's_label': ('Texto ao lado do ícone', 'Text next to the icon'),
    'label_critical': ('Mais crítica', 'Most critical'), 'label_all': ('Todas', 'All'), 'label_none': ('Nenhum', 'None'),
    's_alerts': ('Alertas', 'Alerts'), 'warn_at': ('Amarelo com uso de', 'Yellow at usage of'),
    'crit_above': ('Vermelho com uso acima de', 'Red at usage above'),
    's_budget_day': ('Meta do dia', 'Daily goal'), 's_budget_month': ('Meta de 30 dias', '30-day goal'),
    's_notifications': ('Notificações do desktop', 'Desktop notifications'),
    's_update_check': ('Avisar sobre atualizações', 'Notify about updates'),
    's_export_csv': ('Exportar histórico CSV', 'Export history CSV'),
    'export_ok': ('CSV gravado em {path}', 'CSV saved to {path}'),
    'export_fail': ('Não deu para exportar o CSV', 'Could not export the CSV'),
    's_data': ('Coletor', 'Collector'), 'interval': ('Intervalo de coleta', 'Collection interval'),
    's_about': ('Sobre', 'About'), 'created_by': ('Criado por {name} · Licença GPL-3.0', 'Created by {name} · GPL-3.0 license'),
    'site': ('Site do autor', "Author's website"), 'code': ('Código no GitHub', 'Code on GitHub'),
}


class Words(core.Text):
    """Textos da janela, sobre a mesma formatação (números, datas) da bandeja."""

    def __call__(self, key, **values):
        if key in WINDOW_STRINGS:
            text = WINDOW_STRINGS[key][0 if self.language == 'pt' else 1]
            return text.format(**values)
        return super().__call__(key, **values)


# ---------------------------------------------------------------- cálculos


def projected_exhaustion(window, now):
    """Mantido o ritmo médio desde o início da janela, quando ela chega a 100%."""
    reset = core.parse_time(window.get('resetsAt'))
    minutes = window.get('windowMinutes') or (300 if window.get('kind') == 'session' else 10080 if str(window.get('kind', '')).startswith('weekly') else 0)
    used = window.get('usedPct')
    if reset is None or not minutes or used < PACE_MIN_PCT or used >= 100:
        return None
    length = minutes * 60
    elapsed = now - (reset - length)
    if elapsed < length * PACE_MIN_ELAPSED or elapsed > length:
        return None
    at = now + elapsed * (100 - used) / used
    return at if at < reset else None


def pace_of(window, level, now, words):
    """Linha de ritmo de uma janela, igual à do painel do GNOME, ou None."""
    if level == 'off':
        return None
    if window.get('usedPct', 0) >= 100:
        return words('pace_full'), 'pace-crit'
    pace = window.get('pace')
    if isinstance(pace, dict) and pace.get('basis') == 'recent':
        at = core.parse_time(pace.get('exhaustsAt'))
        at = at if at is not None and at > now else None
    else:
        at = projected_exhaustion(window, now)
    if at is None:
        return None
    return words('pace_out', time=words.duration(at - now)), 'pace'


def pct_level(used, options):
    if used > max(options['crit'], options['warn']):
        return 'crit'
    if used >= options['warn']:
        return 'warn'
    return 'ok'


# ---------------------------------------------------------------- peças


def label(text, *classes, xalign=0.0, wrap=False, markup=False, hexpand=False, halign=None):
    widget = Gtk.Label(xalign=xalign, hexpand=hexpand)
    if markup:
        widget.set_markup(text)
    else:
        widget.set_text(text)
    if wrap:
        widget.set_wrap(True)
        widget.set_max_width_chars(44)
    if halign is not None:
        widget.set_halign(halign)
    for name in classes:
        widget.add_css_class(name)
    return widget


def box(vertical=False, spacing=0, *classes, hexpand=False):
    widget = Gtk.Box(orientation=Gtk.Orientation.VERTICAL if vertical else Gtk.Orientation.HORIZONTAL,
                     spacing=spacing, hexpand=hexpand)
    for name in classes:
        widget.add_css_class(name)
    return widget


def dot(level):
    widget = Gtk.Box(valign=Gtk.Align.CENTER)
    widget.add_css_class('dot')
    widget.add_css_class(level)
    return widget


def ring_area(size, fraction):
    """A marca do TokenBar: anel grafite com o arco verde."""
    area = Gtk.DrawingArea(valign=Gtk.Align.CENTER)
    area.set_content_width(size)
    area.set_content_height(size)

    def draw(_area, cr, width, height):
        line = max(2.0, min(width, height) * 0.19)
        radius = (min(width, height) - line) / 2
        cr.set_line_width(line)
        cr.set_source_rgba(0x3a / 255, 0x3f / 255, 0x46 / 255, 1)
        cr.arc(width / 2, height / 2, radius, 0, 2 * math.pi)
        cr.stroke()
        cr.set_source_rgba(0x4f / 255, 0xe3 / 255, 0x7b / 255, 1)
        start = -math.pi / 2
        cr.arc(width / 2, height / 2, radius, start, start + 2 * math.pi * fraction)
        cr.stroke()

    area.set_draw_func(draw)
    return area


def chart_area(series, highlight):
    area = Gtk.DrawingArea()
    area.set_content_width(CONTENT_WIDTH)
    area.set_content_height(40)
    use_cost = any((day.get('costUsd') or 0) > 0 for day in series)
    values = [(day.get('costUsd') if use_cost else day.get('tokens')) or 0 for day in series]
    peak = max(values + [1e-9])

    def draw(_area, cr, width, height):
        gap = max(1, round(width / 180))
        bar = (width - gap * (len(values) - 1)) / len(values)
        for index, value in enumerate(values):
            bar_height = max(2, value / peak * height) if value > 0 else 1
            if index >= len(values) - highlight:
                cr.set_source_rgba(0.663, 0.486, 0.973, 1)
            else:
                cr.set_source_rgba(1, 1, 1, 0.14)
            cr.rectangle(index * (bar + gap), height - bar_height, bar, bar_height)
            cr.fill()

    area.set_draw_func(draw)
    return area


def flat_button(child, on_click, *classes):
    button = Gtk.Button()
    button.set_child(child)
    for name in classes or ('flat-row',):
        button.add_css_class(name)
    button.connect('clicked', lambda *_: on_click())
    return button


def text_button(text, on_click, *classes, hexpand=False):
    button = Gtk.Button(label=text, hexpand=hexpand)
    for name in classes:
        button.add_css_class(name)
    button.connect('clicked', lambda *_: on_click())
    return button


def choice(options, current, on_pick):
    """Controle segmentado em pílula, como o do painel."""
    widget = box(False, 4, 'segmented', 'choice')
    buttons = []

    def select(value):
        for option_value, button in buttons:
            if option_value == value:
                button.add_css_class('primary')
            else:
                button.remove_css_class('primary')

    for value, text in options:
        button = text_button(text, lambda value=value: (select(value), on_pick(value)), 'tb', 'small', hexpand=True)
        buttons.append((value, button))
        widget.append(button)
    select(current)
    return widget


def setting_row(text, control):
    row = box(False, 8)
    row.append(label(text, hexpand=True))
    control.set_valign(Gtk.Align.CENTER)
    row.append(control)
    return row


def labeled(text, control):
    widget = box(True, 6)
    widget.append(label(text, 'muted', 'small'))
    widget.append(control)
    return widget


def stepper(read, write, fmt):
    widget = box(False, 4)
    value = label(fmt(read()), xalign=0.5)
    value.set_size_request(52, -1)

    def step(direction):
        write(direction)
        value.set_text(fmt(read()))

    widget.append(text_button('−', lambda: step(-1), 'step'))
    widget.append(value)
    widget.append(text_button('+', lambda: step(1), 'step'))
    return widget


def is_wayland():
    display = Gdk.Display.get_default()
    return display is not None and 'Wayland' in type(display).__name__


class X11Placer:
    """No X11 (Xfce, Cinnamon, MATE...) o GTK 4 não posiciona janelas: falamos
    direto com a Xlib para abrir o painel junto do ícone, dentro da área útil
    da tela, e fora da barra de tarefas — como um menu."""

    @classmethod
    def create(cls):
        display = Gdk.Display.get_default()
        if display is None or 'X11' not in type(display).__name__:
            return None
        try:
            gi.require_version('GdkX11', '4.0')
            from gi.repository import GdkX11  # noqa: F401
            lib = ctypes.CDLL('libX11.so.6')
        except (OSError, ImportError, ValueError):
            return None
        placer = cls(lib)
        return placer if placer.dpy else None  # sem conexão com o X: segue sem posicionar

    def __init__(self, lib):
        self.lib = lib
        lib.XOpenDisplay.restype = ctypes.c_void_p
        lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        lib.XDefaultRootWindow.restype = ctypes.c_ulong
        lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        lib.XInternAtom.restype = ctypes.c_ulong
        lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        lib.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int,
                                        ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        lib.XMoveWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int]
        lib.XFlush.argtypes = [ctypes.c_void_p]
        lib.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_void_p] * 7
        lib.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
                                           ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                           ctypes.c_void_p, ctypes.c_void_p]
        lib.XFree.argtypes = [ctypes.c_void_p]
        self.rect = None
        self.dpy = lib.XOpenDisplay(None)
        self.root = lib.XDefaultRootWindow(self.dpy) if self.dpy else 0

    def atom(self, name):
        return self.lib.XInternAtom(self.dpy, name.encode(), 0)

    def xid(self, window):
        surface = window.get_surface()
        return surface.get_xid() if surface is not None and hasattr(surface, 'get_xid') else None

    def prepare(self, window):
        xid = self.xid(window)
        if not xid:
            return
        kind = (ctypes.c_ulong * 1)(self.atom('_NET_WM_WINDOW_TYPE_UTILITY'))
        self.lib.XChangeProperty(self.dpy, xid, self.atom('_NET_WM_WINDOW_TYPE'), self.atom('ATOM'), 32, 0, kind, 1)
        states = (ctypes.c_ulong * 3)(self.atom('_NET_WM_STATE_SKIP_TASKBAR'), self.atom('_NET_WM_STATE_SKIP_PAGER'),
                                      self.atom('_NET_WM_STATE_ABOVE'))
        self.lib.XChangeProperty(self.dpy, xid, self.atom('_NET_WM_STATE'), self.atom('ATOM'), 32, 0, states, 3)
        self.lib.XFlush(self.dpy)

    def pointer(self):
        ints = [ctypes.c_int() for _ in range(4)]
        child, root_win, mask = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_uint()
        self.lib.XQueryPointer(self.dpy, self.root, ctypes.byref(root_win), ctypes.byref(child), ctypes.byref(ints[0]),
                               ctypes.byref(ints[1]), ctypes.byref(ints[2]), ctypes.byref(ints[3]), ctypes.byref(mask))
        return ints[0].value, ints[1].value

    def watch_clicks(self, on_click):
        """Avisa de todo clique na tela (XInput2, eventos "raw": não prende o
        mouse de ninguém). Assim o painel fecha com um clique fora mesmo onde
        não há janela para receber o foco — o fundo vazio, por exemplo."""
        try:
            xi = ctypes.CDLL('libXi.so.6')
        except OSError:
            return False

        class EventMask(ctypes.Structure):
            _fields_ = [('deviceid', ctypes.c_int), ('mask_len', ctypes.c_int), ('mask', ctypes.c_void_p)]

        self.lib.XConnectionNumber.argtypes = [ctypes.c_void_p]
        self.lib.XPending.argtypes = [ctypes.c_void_p]
        self.lib.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        xi.XIQueryVersion.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
        xi.XISelectEvents.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_int]
        events = self.lib.XOpenDisplay(None)
        major, minor = ctypes.c_int(2), ctypes.c_int(0)
        if not events or xi.XIQueryVersion(events, ctypes.byref(major), ctypes.byref(minor)) != 0:
            return False
        bits = (ctypes.c_ubyte * 4)()
        bits[15 >> 3] |= 1 << (15 & 7)  # XI_RawButtonPress
        mask = EventMask(1, 4, ctypes.cast(bits, ctypes.c_void_p))  # XIAllMasterDevices
        xi.XISelectEvents(events, self.lib.XDefaultRootWindow(events), ctypes.byref(mask), 1)
        self.lib.XFlush(events)
        buffer = ctypes.create_string_buffer(256)

        def drain(*_):
            pressed = False
            while self.lib.XPending(events):
                self.lib.XNextEvent(events, buffer)
                pressed = True
            if pressed:
                on_click()
            return True

        self._keep = (xi, events, bits, mask, buffer)
        GLib.unix_fd_add_full(GLib.PRIORITY_DEFAULT, self.lib.XConnectionNumber(events), GLib.IOCondition.IN, drain)
        return True

    def outside(self):
        if self.rect is None:
            return False
        x, y = self.pointer()
        left, top, width, height = self.rect
        return not (left <= x < left + width and top <= y < top + height)

    def workarea(self, fallback):
        kind, fmt, count, rest = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
        data = ctypes.c_void_p()
        ok = self.lib.XGetWindowProperty(self.dpy, self.root, self.atom('_NET_WORKAREA'), 0, 4, 0, 0, ctypes.byref(kind),
                                         ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(rest), ctypes.byref(data))
        if ok != 0 or not data.value:
            return fallback
        try:
            if count.value < 4:
                return fallback
            values = ctypes.cast(data, ctypes.POINTER(ctypes.c_long))
            return tuple(values[i] for i in range(4))
        finally:
            self.lib.XFree(data)

    def place(self, window, margin=8):
        xid = self.xid(window)
        if not xid:
            return
        width, height = window.get_width(), window.get_height()
        monitor = Gdk.Display.get_default().get_monitors().get_item(0).get_geometry()
        left, top, area_w, area_h = self.workarea((0, 0, monitor.width, monitor.height))
        px, py = self.pointer()
        x = min(max(left + margin, px - width // 2), left + area_w - width - margin)
        # Barra em cima: o painel desce do topo; barra embaixo: sobe do rodapé.
        y = top + margin if py < top + area_h / 2 else top + area_h - height - margin
        self.lib.XMoveWindow(self.dpy, xid, x, y)
        self.lib.XFlush(self.dpy)
        self.rect = (x, y, width, height)


# ---------------------------------------------------------------- janela


class PanelWindow:
    def __init__(self, state_path, config_path, collector, on_hide=None, dock=False):
        # dock=True: janela comum, com a logo na barra de baixo do sistema; o
        # clique no ícone de lá abre e minimiza, como qualquer programa.
        self.dock = dock
        self.state_path = state_path
        self.config_path = config_path
        self.collector = collector
        self.on_hide = on_hide
        self.view = 'main'
        self.period = 'today'
        self.expanded = None  # contas abertas; None = só a primeira
        self.details = set()
        self.refreshing = False
        self.hidden_at = 0.0
        self.scroll_position = 0.0
        self.update_status = None
        self.refresh_label = None
        self.export_message = None
        self.state = None
        self.options = None
        self.words = None

        provider = Gtk.CssProvider()
        provider.load_from_string(CSS)
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        Gtk.Window.set_default_icon_name('tokenbar')
        self.window = Gtk.Window(title='TokenBar', decorated=False, resizable=False)
        self.window.add_css_class('tokenbar')
        self.window.set_default_size(CONTENT_WIDTH + 2 * 12 + 2, -1)
        if dock:
            self.x11 = None
            self.layer = False
            keys = Gtk.EventControllerKey()
            keys.connect('key-pressed', lambda _c, key, *_: (self.window.minimize(), True)[1] if key == Gdk.KEY_Escape else False)
            self.window.add_controller(keys)
            self.window.connect('close-request', lambda *_: (self.window.minimize(), True)[1])
            return
        self.x11 = X11Placer.create()
        if self.x11:
            self.window.connect('realize', lambda *_: self.x11.prepare(self.window))
            self.x11.watch_clicks(self._click_anywhere)
        self.layer = False
        if not self.x11 and LayerShell and is_wayland() and LayerShell.is_supported():
            self.layer = True
            LayerShell.init_for_window(self.window)
            LayerShell.set_layer(self.window, LayerShell.Layer.OVERLAY)
            LayerShell.set_keyboard_mode(self.window, LayerShell.KeyboardMode.ON_DEMAND)
            self.anchor(None, None)
        keys = Gtk.EventControllerKey()
        keys.connect('key-pressed', lambda _c, key, *_: (self.hide(), True)[1] if key == Gdk.KEY_Escape else False)
        self.window.add_controller(keys)
        # Como um painel: fechar ao clicar fora.
        self.window.connect('notify::is-active', lambda *_: None if self.window.is_active() else GLib.timeout_add(150, self._hide_if_inactive))
        self.window.connect('close-request', lambda *_: (self.hide(), True)[1])

    # ---- dados

    def load(self):
        self.state = core.load_state(self.state_path)
        self.options = core.load_options(self.config_path)
        self.words = Words(self.options['language'])

    def providers(self):
        items = [p for p in (self.state or {}).get('providers', []) if isinstance(p, dict) and p.get('id')]
        return core.apply_provider_order(items, (self.options or {}).get('provider_order') or [])

    def level(self, provider):
        return core.level_of(provider, self.options['warn'], self.options['crit'])

    def shown(self, used):
        return 100 - used if self.options['show_remaining'] else used

    def money(self, usd):
        return self.words.money(usd, (self.state or {}).get('fx'), self.options['currency'])

    # ---- montagem

    def render(self):
        self.load()
        w = self.words
        surface = box(True, 0, 'surface')
        popup = box(True, 12, 'popup')
        surface.append(popup)

        header = box(False, 8, 'header')
        header.append(ring_area(18, 0.7))
        header.append(label('Token<span foreground="#4fe37b">Bar</span>', 'title', markup=True))
        pill = box(False, 6, 'pill', hexpand=True)
        pill.set_halign(Gtk.Align.END)
        pill.set_valign(Gtk.Align.CENTER)
        updated = core.parse_time((self.state or {}).get('updatedAt'))
        stale = updated is None or time.time() - updated > core.STALE_AFTER_S
        pill.append(dot('warn' if stale else 'ok'))
        pill.append(label(w('updated', age=w.age(time.time() - updated)) if updated else '—'))
        header.append(pill)
        popup.append(header)

        if self.view == 'main':
            self._main(popup, stale)
        else:
            self._settings(popup)

        footer = box(False, 4, 'segmented')
        self.refresh_label = text_button(w('refreshing') if self.refreshing else w('refresh'), self.refresh, 'tb', 'primary', hexpand=True)
        footer.append(self.refresh_label)
        footer.append(text_button(w('back') if self.view == 'settings' else w('settings'), self.toggle_view, 'tb', hexpand=True))
        popup.append(footer)
        self.window.set_child(surface)

    def _scroller(self, content):
        scroller = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER, vscrollbar_policy=Gtk.PolicyType.AUTOMATIC)
        display = Gdk.Display.get_default()
        monitors = display.get_monitors() if display else None
        height = 900
        if monitors and monitors.get_n_items():
            height = monitors.get_item(0).get_geometry().height
        # Cabeçalho, avisos e rodapé ficam fora da rolagem; sobra espaço para eles.
        scroller.set_max_content_height(max(240, height - 330))
        scroller.set_propagate_natural_height(True)
        scroller.set_child(content)
        # Dados novos redesenham o painel: a rolagem continua onde estava.
        adjustment = scroller.get_vadjustment()
        position = self.scroll_position
        GLib.idle_add(lambda: (adjustment.set_value(position), False)[1])
        adjustment.connect('value-changed', lambda a: setattr(self, 'scroll_position', a.get_value()))
        return scroller

    def _main(self, popup, stale):
        w = self.words
        providers = self.providers()
        warning = w('no_data') if self.state is None else w('stale') if stale else w('no_accounts') if not providers else ''
        if warning:
            popup.append(label(warning, 'warning', wrap=True))
        for service in (self.state or {}).get('services') or []:
            if service and service.get('indicator') not in (None, 'none'):
                popup.append(label(w('incident', name=service.get('name'), text=service.get('description') or service.get('indicator')), 'warning', wrap=True))
        update = (self.state or {}).get('update')
        if isinstance(update, dict) and (update.get('available') or self.update_status):
            popup.append(self._update(update))

        sections = box(True, 8)
        summary = self._summary(providers)
        if summary:
            sections.append(summary)
        expanded = self.expanded if self.expanded is not None else {providers[0]['id']} if providers else set()
        for provider in providers:
            sections.append(self._card(provider, provider['id'] in expanded))
        popup.append(self._scroller(sections))

    def _update(self, update):
        w = self.words
        widget = box(True, 6, 'update')
        widget.append(label(w('update_title'), 'update-title'))
        summary = ' · '.join(str(part) for part in (update.get('latest'), update.get('summary')) if part)
        widget.append(label(summary, 'small', wrap=True))
        source = update.get('source')
        status = self.update_status
        how = {'running': 'update_running', 'done': 'update_done', 'failed': 'update_failed'}.get(status) or ('update_auto' if source else 'update_how')
        widget.append(label(w(how), 'tiny', 'muted', wrap=True))
        row = box(False, 8)
        row.append(label('', hexpand=True))
        row.append(text_button(w('update_view'), lambda: self.open_uri(update.get('url') or core.REPOSITORY_URL), 'tb', 'small'))
        if source and status not in ('running', 'done'):
            row.append(text_button(w('update_now'), lambda: self.self_update(source), 'tb', 'small', 'primary'))
        widget.append(row)
        return widget

    def self_update(self, source):
        """git pull + ./install.sh no clone usado na instalação, sem terminal."""
        self.update_status = 'running'
        self.render()
        script = ('eval "$(grep -m1 "^PATH=" "$HOME/.local/bin/tokenbar-collector" 2>/dev/null)"; export PATH; '
                  'cd "$1" && git pull --ff-only && ./install.sh')
        try:
            process = subprocess.Popen(['bash', '-c', script, 'tokenbar-update', source],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            self.update_status = 'failed'
            self.render()
            return

        def wait():
            if process.poll() is None:
                return True
            self.update_status = 'done' if process.returncode == 0 else 'failed'
            self.render()
            return False

        GLib.timeout_add(500, wait)

    def _summary(self, providers):
        w = self.words
        usage = (self.state or {}).get('usage')
        priced = [p for p in providers if isinstance(p.get('costTodayUsd'), (int, float))]
        if not priced and not usage:
            return None
        days = {'today': 1, '7': 7, '30': 30}[self.period]
        totals = (usage or {}).get(f'last{days}') if days > 1 else None
        if not totals:
            totals = {'costUsd': sum(p['costTodayUsd'] for p in priced),
                      'tokens': sum(p.get('tokensToday') or 0 for p in providers if isinstance(p.get('tokensToday'), (int, float)))}
        card = box(True, 10, 'card')
        top = box(False, 8)
        top.append(label(w('summary'), 'group-title', hexpand=True))
        if usage:
            top.append(choice([('today', w('today')), ('7', w('days7')), ('30', w('days30'))], self.period, self.set_period))
        card.append(top)
        row = box(False, 8)
        row.append(label(self.money(totals.get('costUsd') or 0), 'big', hexpand=True))
        side = box(True, 0)
        side.set_valign(Gtk.Align.END)
        side.append(label(w('tokens'), 'muted', 'small', xalign=1))
        side.append(label(w.tokens(totals.get('tokens') or 0), 'medium', xalign=1))
        row.append(side)
        card.append(row)
        series = (usage or {}).get('series') or []
        if sum(1 for day in series if day.get('tokens')) > 1:
            card.append(chart_area(series, days))
        return card

    def _card(self, provider, open_):
        w = self.words
        level = self.level(provider)
        used = core.worst_used(provider)
        card = box(True, 12, 'card')

        head = box(False, 8)
        head.append(label(provider.get('label', provider['id']), 'tag'))
        head.append(label(provider.get('name', ''), 'name', hexpand=True))
        if not open_ and used is not None:
            head.append(label(f'{self.shown(used)}%', 'medium', 'value', level))
        pill = box(False, 6, 'pill')
        pill.set_valign(Gtk.Align.CENTER)
        pill.append(dot(level))
        pill.append(label(provider.get('plan') or '—'))
        head.append(pill)
        head.append(label('▾' if open_ else '›', 'chevron'))
        card.append(flat_button(head, lambda: self.toggle_card(provider['id'])))

        soft = provider.get('status') in ('idle', 'rate_limited')
        if not open_:
            if provider.get('error') and not soft:
                card.append(label(str(provider['error']), 'error', wrap=True))
            return card

        hero = box(False, 8)
        hero.append(label('—' if used is None else f'{self.shown(used)}%', 'big', *(['muted'] if level == 'off' else [])))
        if used is not None:
            caption = label(w('remaining') if self.options['show_remaining'] else w('used'), 'muted', 'small', 'big-caption')
            caption.set_valign(Gtk.Align.END)
            hero.append(caption)
        if isinstance(provider.get('tokensToday'), (int, float)) or isinstance(provider.get('costTodayUsd'), (int, float)):
            today = box(True, 0, hexpand=True)
            today.set_valign(Gtk.Align.END)
            today.append(label(w('tokens_today'), 'muted', 'small', xalign=1))
            if isinstance(provider.get('tokensToday'), (int, float)):
                today.append(label(w.tokens(provider['tokensToday']), 'medium', xalign=1))
            if isinstance(provider.get('costTodayUsd'), (int, float)):
                today.append(label('≈ ' + self.money(provider['costTodayUsd']), 'muted', 'small', xalign=1))
            hero.append(today)
        card.append(hero)

        groups = {}
        for window in provider.get('windows') or []:
            if isinstance(window, dict) and isinstance(window.get('usedPct'), (int, float)):
                groups.setdefault(window.get('group') or '', []).append(window)
        now = time.time()
        for name, windows in groups.items():
            if name:
                card.append(label(name, 'group-title'))
            for start in range(0, len(windows), 2):
                pair = windows[start:start + 2]
                width = (CONTENT_WIDTH - COLUMN_GAP) // 2 if len(pair) == 2 else CONTENT_WIDTH
                levels = ['off' if level == 'off' else pct_level(wd['usedPct'], self.options) for wd in pair]
                reserve = any(pace_of(wd, lv, now, w) for wd, lv in zip(pair, levels))
                row = box(False, COLUMN_GAP)
                for window, window_level in zip(pair, levels):
                    row.append(self._window(window, window_level, now, width, reserve))
                card.append(row)

        if provider.get('error'):
            text = w('last_value', text=provider['error']) if provider.get('status') == 'rate_limited' else str(provider['error'])
            card.append(label(text, 'muted' if soft else 'error', *(['small'] if soft else []), wrap=True))

        if provider.get('tokensBreakdown') or provider.get('modelsToday') or provider.get('sessionsToday'):
            showing = provider['id'] in self.details
            if showing:
                card.append(self._details(provider))
            card.append(text_button(w('details_hide') if showing else w('details_show'), lambda: self.toggle_details(provider['id']), 'ghost'))
        return card

    def _window(self, window, level, now, width, reserve):
        w = self.words
        widget = box(True, 6)
        widget.set_size_request(width, -1)
        row = box(False, 6)
        name = window.get('label') or window.get('kind') or ''
        row.append(label(str(name), 'muted', 'small'))
        shown = self.shown(window['usedPct'])
        row.append(label(f'{shown}%', 'medium', xalign=1, hexpand=True))
        widget.append(row)
        filled = 0 if shown <= 0 else min(SEGMENTS, max(1, round(shown / (100 / SEGMENTS))))
        segment_width = (width - SEGMENT_GAP * (SEGMENTS - 1)) // SEGMENTS
        meter = box(False, SEGMENT_GAP)
        for index in range(SEGMENTS):
            segment = Gtk.Box()
            segment.set_size_request(segment_width, 12)
            segment.add_css_class('segment')
            if index < filled:
                segment.add_css_class(level)
            meter.append(segment)
        widget.append(meter)
        reset = w.reset(window.get('resetsAt'), now)
        widget.append(label(reset or ' ', 'muted', 'tiny'))
        if reserve:
            pace = pace_of(window, level, now, w)
            widget.append(label(pace[0] if pace else ' ', 'tiny', *([pace[1]] if pace else [])))
        return widget

    def _details(self, provider):
        w = self.words
        widget = box(True, 4)

        def line(name, item):
            row = box(False, 8, 'detail-row')
            row.append(label(name, hexpand=True))
            parts = [w.tokens(item.get('tokens'))]
            if isinstance(item.get('costUsd'), (int, float)):
                parts.append(self.money(item['costUsd']))
            row.append(label(' · '.join(parts), 'muted'))
            return row

        split = provider.get('tokensBreakdown')
        if isinstance(split, dict):
            widget.append(label(w('d_tokens'), 'group-title'))
            widget.append(line(w('d_inout'), {'tokens': (split.get('input') or 0) + (split.get('output') or 0)}))
            widget.append(line(w('d_write'), {'tokens': split.get('cacheWrite') or 0}))
            widget.append(line(w('d_read'), {'tokens': split.get('cacheRead') or 0}))
        if provider.get('costPartial'):
            widget.append(label(w('partial'), 'pace', 'tiny', wrap=True))
        if provider.get('modelsToday'):
            widget.append(label(w('d_models'), 'group-title'))
            for model in provider['modelsToday']:
                name = str(model.get('model', '')).replace('claude-', '', 1)
                widget.append(line(name, model))
        if provider.get('sessionsToday'):
            widget.append(label(w('d_sessions'), 'group-title'))
            for session in provider['sessionsToday']:
                row = line(session.get('project') or w('no_project'), session)
                path = session.get('path')
                widget.append(flat_button(row, lambda path=path: self.open_uri(GLib.filename_to_uri(path, None))) if path else row)
        return widget

    # ---- configurações (gravadas no config.json do coletor)

    def _settings(self, popup):
        w = self.words
        config = self.read_config()
        cards = box(True, 8)

        accounts = box(True, 12, 'card')
        accounts.append(label(w('s_accounts'), 'group-title'))
        accounts.append(label(w('s_drag'), 'muted', 'tiny'))
        legend = box(False, 8)
        legend.append(label('', hexpand=True))
        legend.append(label(w('s_collect'), 'muted', 'tiny'))
        accounts.append(legend)
        disabled = set(config.get('disabledProviders') or [])
        known = (self.state or {}).get('accounts') or [{'id': p['id'], 'label': p.get('label'), 'name': p.get('name')} for p in self.providers()]
        known = core.apply_provider_order(known, config.get('providerOrder') or [])
        for account in known:
            row = box(False, 8, 'account-row')
            handle = box(False, 8, 'account-handle', hexpand=True)
            handle.append(label(account.get('label') or account['id'], 'tag'))
            handle.append(label(account.get('name') or '', hexpand=True))
            handle.set_cursor(Gdk.Cursor.new_from_name('grab'))
            row.append(handle)
            switch = Gtk.Switch(active=account['id'] not in disabled, valign=Gtk.Align.CENTER)
            switch.connect('notify::active', lambda sw, _p, ident=account['id']: self.set_collect(ident, sw.get_active()))
            row.append(switch)
            self._attach_account_drag(handle, row, account['id'])
            accounts.append(row)
        cards.append(accounts)

        display = box(True, 12, 'card')
        display.append(label(w('s_display'), 'group-title'))
        display.append(labeled(w('s_language'), choice([('auto', w('lang_auto')), ('pt', w('lang_pt')), ('en', w('lang_en'))],
                                                        config.get('language') or 'auto', lambda v: self.set_config('language', None if v == 'auto' else v, rerender=True))))
        display.append(labeled(w('s_percent'), choice([('remaining', w('pct_left')), ('used', w('pct_used'))],
                                                       'remaining' if self.options['show_remaining'] else 'used',
                                                       lambda v: self.set_bar('showRemaining', v == 'remaining'))))
        display.append(labeled(w('s_currency'), choice([('brl', w('brl')), ('usd', w('usd'))], self.options['currency'],
                                                        lambda v: self.set_bar('currency', v))))
        dock = Gtk.Switch(active=config.get('dock') is True, valign=Gtk.Align.CENTER)
        dock.connect('notify::active', lambda sw, _p: self.set_config('dock', True if sw.get_active() else None))
        display.append(setting_row(w('s_dock'), dock))
        display.append(labeled(w('s_label'), choice([('critical', w('label_critical')), ('all', w('label_all')), ('none', w('label_none'))],
                                                     self.options['label'], lambda v: self.set_bar('label', v))))
        cards.append(display)

        colors = box(True, 12, 'card')
        colors.append(label(w('s_alerts'), 'group-title'))
        colors.append(setting_row(w('warn_at'), stepper(lambda: self.read_bar().get('warn', 60),
                                                        lambda d: self.set_bar('warn', max(5, min(self.read_bar().get('crit', 85) - 5, self.read_bar().get('warn', 60) + 5 * d)), rerender=False),
                                                        lambda v: f'{v}%')))
        colors.append(setting_row(w('crit_above'), stepper(lambda: self.read_bar().get('crit', 85),
                                                           lambda d: self.set_bar('crit', max(self.read_bar().get('warn', 60) + 5, min(100, self.read_bar().get('crit', 85) + 5 * d)), rerender=False),
                                                           lambda v: f'{v}%')))
        colors.append(setting_row(w('s_budget_day'), stepper(lambda: self.read_config().get('budgetDaily', 0),
                                                             lambda d: self.set_config('budgetDaily', max(0, min(100000, self.read_config().get('budgetDaily', 0) + 5 * d))),
                                                             lambda v: str(v) if v else '—')))
        colors.append(setting_row(w('s_budget_month'), stepper(lambda: self.read_config().get('budgetMonthly', 0),
                                                               lambda d: self.set_config('budgetMonthly', max(0, min(1000000, self.read_config().get('budgetMonthly', 0) + 20 * d))),
                                                               lambda v: str(v) if v else '—')))
        notifications = Gtk.Switch(active=config.get('notifications') is not False, valign=Gtk.Align.CENTER)
        notifications.connect('notify::active', lambda sw, _p: self.set_config('notifications', sw.get_active()))
        colors.append(setting_row(w('s_notifications'), notifications))
        update_check = Gtk.Switch(active=config.get('updateCheck') is not False, valign=Gtk.Align.CENTER)
        update_check.connect('notify::active', lambda sw, _p: self.set_config('updateCheck', sw.get_active()))
        colors.append(setting_row(w('s_update_check'), update_check))
        cards.append(colors)

        data = box(True, 12, 'card')
        data.append(label(w('s_data'), 'group-title'))
        data.append(setting_row(w('interval'), stepper(lambda: self.read_config().get('intervalSec', 120),
                                                        lambda d: self.set_config('intervalSec', max(60, min(600, self.read_config().get('intervalSec', 120) + 30 * d))),
                                                        lambda v: f'{v} s')))
        export_btn = text_button(w('s_export_csv'), self.export_csv, 'tb', 'small')
        data.append(export_btn)
        if self.export_message:
            data.append(label(self.export_message, 'muted', 'small'))
        cards.append(data)

        about = box(True, 12, 'card')
        about.append(label(w('s_about'), 'group-title'))
        about.append(label('TokenBar'))
        about.append(label(w('created_by', name=core.AUTHOR), 'muted', 'small'))
        links = box(False, 4, 'segmented', 'choice')
        links.append(text_button(w('site'), lambda: self.open_uri(core.AUTHOR_URL), 'tb', 'small', hexpand=True))
        links.append(text_button(w('code'), lambda: self.open_uri(core.REPOSITORY_URL), 'tb', 'small', hexpand=True))
        about.append(links)
        cards.append(about)
        popup.append(self._scroller(cards))

    def read_config(self):
        try:
            with open(self.config_path, encoding='utf-8') as file:
                data = json.load(file)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def read_bar(self):
        bar = self.read_config().get('bar')
        return bar if isinstance(bar, dict) else {}

    def write_config(self, config):
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        tmp = f'{self.config_path}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as file:
            json.dump(config, file, indent=2, ensure_ascii=False)
            file.write('\n')
        os.replace(tmp, self.config_path)

    def set_config(self, key, value, rerender=False):
        config = self.read_config()
        if value is None:
            config.pop(key, None)
        else:
            config[key] = value
        self.write_config(config)
        if rerender:
            GLib.idle_add(lambda: (self.render(), False)[1])

    def set_bar(self, key, value, rerender=True):
        config = self.read_config()
        bar = config.get('bar') if isinstance(config.get('bar'), dict) else {}
        bar[key] = value
        config['bar'] = bar
        self.write_config(config)
        if rerender:
            GLib.idle_add(lambda: (self.render(), False)[1])

    def set_collect(self, ident, active):
        config = self.read_config()
        disabled = [d for d in config.get('disabledProviders') or [] if d != ident]
        if not active:
            disabled.append(ident)
        config['disabledProviders'] = disabled
        self.write_config(config)

    def _attach_account_drag(self, handle, row, ident):
        source = Gtk.DragSource.new()
        source.set_actions(Gdk.DragAction.MOVE)

        def prepare(_src, _x, _y):
            return Gdk.ContentProvider.new_for_value(str(ident))

        def drag_begin(src, _drag):
            row.add_css_class('dragging')
            src.set_icon(Gtk.WidgetPaintable.new(handle), 0, 0)

        def drag_end(_src, _drag, _delete):
            row.remove_css_class('dragging')

        source.connect('prepare', prepare)
        source.connect('drag-begin', drag_begin)
        source.connect('drag-end', drag_end)
        handle.add_controller(source)

        drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)

        def on_enter(_target, _x, _y):
            row.add_css_class('drop-hover')
            return Gdk.DragAction.MOVE

        def on_leave(_target):
            row.remove_css_class('drop-hover')

        def on_drop(_target, value, _x, y):
            row.remove_css_class('drop-hover')
            height = max(row.get_height(), 1)
            self.place_account(str(value), ident, after=y > height / 2)
            return True

        drop.connect('enter', on_enter)
        drop.connect('leave', on_leave)
        drop.connect('drop', on_drop)
        row.add_controller(drop)

    def place_account(self, drag_id, target_id, after=False):
        if drag_id == target_id:
            return
        config = self.read_config()
        known = (self.state or {}).get('accounts') or [{'id': p['id']} for p in self.providers()]
        ids = [str(account['id']) for account in known]
        order = [item for item in (config.get('providerOrder') or []) if item in ids]
        for item in ids:
            if item not in order:
                order.append(item)
        if drag_id not in order or target_id not in order:
            return
        order.remove(drag_id)
        to = order.index(target_id)
        if after:
            to += 1
        order.insert(to, drag_id)
        config['providerOrder'] = order
        self.write_config(config)
        GLib.idle_add(lambda: (self.render(), False)[1])

    # ---- ações

    def toggle_card(self, ident):
        providers = self.providers()
        expanded = set(self.expanded if self.expanded is not None else ({providers[0]['id']} if providers else set()))
        expanded.symmetric_difference_update({ident})
        self.expanded = expanded
        GLib.idle_add(lambda: (self.render(), False)[1])

    def toggle_details(self, ident):
        self.details.symmetric_difference_update({ident})
        GLib.idle_add(lambda: (self.render(), False)[1])

    def set_period(self, value):
        self.period = value
        GLib.idle_add(lambda: (self.render(), False)[1])

    def toggle_view(self):
        self.view = 'main' if self.view == 'settings' else 'settings'
        self.scroll_position = 0.0
        GLib.idle_add(lambda: (self.render(), False)[1])

    def export_csv(self):
        downloads = os.path.join(os.path.expanduser('~'), 'Downloads')
        folder = downloads if os.path.isdir(downloads) else os.path.expanduser('~')
        path = os.path.join(folder, f"tokenbar-{time.strftime('%Y-%m-%d')}.csv")
        try:
            result = subprocess.run(
                [self.collector, '--export-csv', path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            self.export_message = self.words('export_ok', path=path) if result.returncode == 0 else self.words('export_fail')
        except OSError:
            self.export_message = self.words('export_fail')
        GLib.idle_add(lambda: (self.render(), False)[1])

    def refresh(self):
        if self.refreshing:
            return
        self.refreshing = True
        self.render()
        try:
            process = subprocess.Popen([self.collector, '--once'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            self.refreshing = False
            self.refresh_label.set_label(self.words('refresh_failed'))
            return

        def wait():
            if process.poll() is None:
                return True
            self.refreshing = False
            self.render()
            if process.returncode != 0 and self.refresh_label:
                self.refresh_label.set_label(self.words('refresh_failed'))
            return False

        GLib.timeout_add(200, wait)

    def open_uri(self, uri):
        try:
            Gio.AppInfo.launch_default_for_uri(uri, None)
        except GLib.Error:
            pass
        if self.dock:
            self.window.minimize()  # continua na barra de baixo
        else:
            self.hide()

    # ---- mostrar/esconder

    @property
    def visible(self):
        return self.window.get_visible()

    def anchor(self, x, y, margin=8):
        """Wayland com layer-shell: prende o painel no canto mais perto do
        ícone (barra embaixo, como no Plasma, abre embaixo)."""
        geometry = None
        monitors = Gdk.Display.get_default().get_monitors()
        if monitors.get_n_items():
            geometry = monitors.get_item(0).get_geometry()
        bottom = geometry is not None and y is not None and y > geometry.height / 2
        left = geometry is not None and x is not None and 0 < x < geometry.width / 3
        Edge = LayerShell.Edge
        for edge, on in ((Edge.TOP, not bottom), (Edge.BOTTOM, bottom), (Edge.LEFT, left), (Edge.RIGHT, not left)):
            LayerShell.set_anchor(self.window, edge, on)
            LayerShell.set_margin(self.window, edge, margin if on else 0)

    def show(self, x=None, y=None):
        self.view = 'main'
        self.scroll_position = 0.0
        self.render()
        if self.layer:
            self.anchor(x, y)
        self.window.present()
        if self.x11:
            # O gerenciador de janelas só aceita a posição depois de mapear.
            self.x11.rect = None
            GLib.timeout_add(30, lambda: (self.x11.place(self.window), False)[1])

    def _click_anywhere(self):
        if self.window.get_visible() and self.x11.outside():
            self.hide()

    def hide(self):
        if self.window.get_visible():
            self.hidden_at = time.monotonic()
            self.window.set_visible(False)
            if self.on_hide:
                self.on_hide()

    def toggle(self, x=None, y=None):
        if self.dock:
            # Aberto: minimiza para a barra; minimizado: traz de volta. (No Wayland
            # uma janela aberta por D-Bus nem sempre ganha o foco, então o que
            # vale é o estado da janela, não o foco.)
            if self.visible and not self.minimized:
                self.window.minimize()
            else:
                self.render()
                self.window.present()
            return
        if self.visible:
            self.hide()
        elif time.monotonic() - self.hidden_at < 0.4:
            # Esse clique no ícone já fechou o painel (clique fora); não reabre.
            return
        else:
            self.show(x, y)

    @property
    def minimized(self):
        surface = self.window.get_surface()
        return bool(surface and hasattr(surface, 'get_state') and surface.get_state() & Gdk.ToplevelState.MINIMIZED)

    def start_minimized(self):
        """Modo dock: aparece já na barra de baixo, minimizado, desde o login.
        O compositor só aceita minimizar depois que a janela terminou de aparecer."""
        self.render()
        self.window.present()
        GLib.timeout_add(1500, lambda: (self.window.minimize(), False)[1])

    def reload_if_visible(self):
        if self.visible and self.view == 'main' and not self.refreshing:
            self.render()

    def _hide_if_inactive(self):
        if not self.window.is_active():
            self.hide()
        return False


APP_ID = 'io.github.diogobritodesign.TokenBar'


def main():
    """Janela aberta pelo ícone da dock. Uma instância só: clicar de novo no
    ícone esconde o painel (não fecha o programa) e o próximo clique o mostra."""
    state_path, config_path, collector = core.default_paths()
    app = Gtk.Application(application_id=APP_ID)
    panel = None

    def activate(_app):
        nonlocal panel
        if panel is None:
            app.hold()  # continua rodando com o painel escondido
            panel = PanelWindow(state_path, config_path, collector)
            panel.window.set_application(app)
            monitor = Gio.File.new_for_path(os.path.dirname(state_path)).monitor_directory(Gio.FileMonitorFlags.NONE, None)
            monitor.connect('changed', lambda *_: panel.reload_if_visible())
            panel.monitor = monitor
        panel.toggle()

    app.connect('activate', activate)
    return app.run([sys.argv[0]])


if __name__ == '__main__':
    sys.exit(main())
