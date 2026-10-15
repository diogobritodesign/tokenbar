#!/usr/bin/env python3
"""Ícone de bandeja do TokenBar para desktops sem a extensão do GNOME.

Fala direto o protocolo de bandeja usado por KDE, Xfce, Cinnamon, MATE, Budgie
e afins (StatusNotifierItem + com.canonical.dbusmenu), só com PyGObject: sem
GTK e sem biblioteca de AppIndicator. Lê o mesmo ~/.cache/tokenbar/state.json
que o coletor grava; não faz rede.
"""

import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime

import gi

gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

REPOSITORY_URL = 'https://github.com/diogobritodesign/tokenbar'
AUTHOR = 'Diogo Brito'
AUTHOR_URL = 'https://diogobrito.com.br/'

# Trilho do anel, o mesmo grafite do logo (assets/tokenbar-mark.svg).
TRACK = (0x3a, 0x3f, 0x46)
DISC = (0x0f, 0x0f, 0x10)
COLORS = {'ok': (0x4f, 0xe3, 0x7b), 'warn': (0xec, 0xe3, 0x8f), 'crit': (0xff, 0x7b, 0x72), 'off': (0x6b, 0x6b, 0x70)}
SOFT_STATUSES = ('ok', 'rate_limited', 'idle')
LEVEL_ORDER = ('off', 'ok', 'warn', 'crit')
STALE_AFTER_S = 10 * 60
POLL_SECONDS = 30

STRINGS = {
    'remaining': ('restante', 'left'),
    'used': ('usado', 'used'),
    'updated': ('atualizado há {age}', 'updated {age} ago'),
    'stale': ('dados desatualizados — coletor parado?', 'stale data — is the collector running?'),
    'no_data': ('sem dados — o coletor ainda não gravou state.json', 'no data — the collector has not written state.json yet'),
    'reset_in': ('reseta em {time}', 'resets in {time}'),
    'reset_soon': ('reseta em instantes', 'resets any moment'),
    'tokens_today': ('tokens hoje: {tokens}', 'tokens today: {tokens}'),
    'cost_today': ('uso hoje: {cost} · {tokens} tokens (preço de API)', 'today: {cost} · {tokens} tokens (API prices)'),
    'refresh': ('Atualizar agora', 'Refresh now'),
    'update': ('Atualização disponível: {version}', 'Update available: {version}'),
    'about': ('Sobre o TokenBar', 'About TokenBar'),
    'site': ('Site do autor ({name})', "Author's website ({name})"),
    'code': ('Código no GitHub', 'Code on GitHub'),
    'quit': ('Sair', 'Quit'),
    'notify_update': ('TokenBar: atualização disponível', 'TokenBar: update available'),
    'notify_login': ('{account}: login expirado', '{account}: login expired'),
    'notify_over': ('{name} em {pct}%', '{name} at {pct}%'),
    'notify_over_body': ('acima do limite vermelho ({crit}%)', 'above the red threshold ({crit}%)'),
    'notify_freed': ('{name} liberado', '{name} is available again'),
    'notify_goal': ('Meta de gasto do dia atingida', 'Daily spending goal reached'),
    'notify_goal_month': ('Meta de gasto dos 30 dias atingida', '30-day spending goal reached'),
    'notify_goal_body': ('{spent} de {goal}, a preço de API.', '{spent} of {goal}, at API prices.'),
}

# ---------------------------------------------------------------- textos


def system_language(env=os.environ):
    locale = env.get('LC_ALL') or env.get('LC_MESSAGES') or env.get('LANG') or ''
    return 'pt' if locale.lower().startswith('pt') else 'en'


class Text:
    def __init__(self, language):
        self.language = language if language in ('pt', 'en') else 'en'

    def __call__(self, key, **values):
        text = STRINGS[key][0 if self.language == 'pt' else 1]
        return text.format(**values)

    def number(self, value, decimals):
        text = f'{value:,.{decimals}f}'
        if self.language == 'pt':
            text = text.replace(',', '\x00').replace('.', ',').replace('\x00', '.')
        return text

    def tokens(self, count):
        if not isinstance(count, (int, float)):
            return '—'
        for limit, suffix in ((1e9, 'B'), (1e6, 'M'), (1e3, 'k')):
            if count >= limit:
                return self.number(count / limit, 1).rstrip('0').rstrip(',.') + suffix
        return str(round(count))

    def money(self, usd, fx, currency):
        rate = (fx or {}).get('usdBrl')
        if currency == 'brl' and isinstance(rate, (int, float)) and rate > 0:
            return f'R$ {self.number(usd * rate, 2)}'
        return f"{'US$' if self.language == 'pt' else '$'} {self.number(usd, 2)}"

    def duration(self, seconds):
        minutes = max(0, round(seconds / 60))
        days, hours, mins = minutes // 1440, (minutes % 1440) // 60, minutes % 60
        if days:
            return f'{days}d {hours}h'
        if hours:
            return f'{hours}h {mins}min'
        return f'{mins}min'

    def reset(self, resets_at, now):
        at = parse_time(resets_at)
        if at is None:
            return ''
        if at - now < 30:
            return self('reset_soon')
        return self('reset_in', time=self.duration(at - now))

    def age(self, seconds):
        seconds = max(0, round(seconds))
        if seconds < 60:
            return f'{seconds} s'
        if seconds < 3600:
            return f'{seconds // 60} min'
        return f'{seconds // 3600} h'


def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


# ---------------------------------------------------------------- estado


def worst_used(provider):
    used = [w.get('usedPct') for w in provider.get('windows') or [] if isinstance(w, dict)]
    used = [u for u in used if isinstance(u, (int, float))]
    return max(used) if used else None


def level_of(provider, warn=60, crit=85):
    used = worst_used(provider)
    if used is None or provider.get('status') not in SOFT_STATUSES:
        return 'off'
    if used > max(crit, warn):
        return 'crit'
    if used >= warn:
        return 'warn'
    return 'ok'


def load_raw_config(config_path):
    try:
        with open(config_path, encoding='utf-8') as file:
            raw = json.load(file)
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def load_options(config_path):
    """Opções da bandeja: o bloco "bar" do config.json do coletor."""
    raw = load_raw_config(config_path)
    bar = raw.get('bar') if isinstance(raw.get('bar'), dict) else {}
    language = raw.get('language') if raw.get('language') in ('pt', 'en') else system_language()
    hidden = bar.get('hiddenProviders') if isinstance(bar.get('hiddenProviders'), list) else []
    return {
        'language': language,
        'show_remaining': bar.get('showRemaining') is not False,
        'warn': int(bar.get('warn', 60)) if isinstance(bar.get('warn', 60), (int, float)) else 60,
        'crit': int(bar.get('crit', 85)) if isinstance(bar.get('crit', 85), (int, float)) else 85,
        'currency': bar.get('currency') if bar.get('currency') in ('brl', 'usd') else ('brl' if language == 'pt' else 'usd'),
        'label': bar.get('label') if bar.get('label') in ('critical', 'all', 'none') else 'critical',
        'hidden_providers': [str(item) for item in hidden],
        'dock': raw.get('dock') is True,
        'notifications': raw.get('notifications') is not False,
        'update_check': raw.get('updateCheck') is not False,
        'budget_daily': int(raw.get('budgetDaily', 0)) if isinstance(raw.get('budgetDaily', 0), (int, float)) else 0,
        'budget_monthly': int(raw.get('budgetMonthly', 0)) if isinstance(raw.get('budgetMonthly', 0), (int, float)) else 0,
    }


def desktop_notify(title, body):
    """Notificação do desktop via notify-send (libnotify), se existir."""
    try:
        subprocess.Popen(
            ['notify-send', '--app-name=TokenBar', '--icon=tokenbar', str(title), str(body or '')],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        pass


class AlertTracker:
    """Mesma lógica de avisos da extensão do GNOME, para a bandeja."""

    def __init__(self):
        self.stamp = None
        self.statuses = {}
        self.windows = {}
        self.budget_day = None
        self.budget_month = None
        self.update_notified = None

    def check(self, state, options, text):
        if not state or state.get('updatedAt') == self.stamp:
            return
        first = self.stamp is None
        self.stamp = state.get('updatedAt')
        enabled = options.get('notifications') is not False
        crit = max(options.get('crit', 85), options.get('warn', 60))
        providers = [p for p in (state.get('providers') or []) if isinstance(p, dict) and p.get('id')]

        update = state.get('update') if isinstance(state.get('update'), dict) else {}
        latest = update.get('latest')
        if enabled and update.get('available') and latest and self.update_notified != latest:
            self.update_notified = latest
            desktop_notify(text('notify_update'), ' · '.join(filter(None, [latest, update.get('summary')])))

        for provider in providers:
            before = self.statuses.get(provider['id'])
            self.statuses[provider['id']] = provider.get('status')
            if not first and enabled and before and before != 'unauthorized' and provider.get('status') == 'unauthorized':
                desktop_notify(
                    text('notify_login', account=provider.get('label') or provider['id']),
                    str(provider.get('error') or ''),
                )

        rate = (state.get('fx') or {}).get('usdBrl')
        brl = options.get('currency') == 'brl' and isinstance(rate, (int, float)) and rate > 0
        symbol = 'R$' if brl else ('US$' if text.language == 'pt' else '$')

        def local_amount(usd):
            return usd * rate if brl else usd

        spent_today = sum(p.get('costTodayUsd') or 0 for p in providers if isinstance(p.get('costTodayUsd'), (int, float)))
        day = datetime.now().strftime('%Y-%m-%d')
        budget_daily = options.get('budget_daily') or 0
        if budget_daily > 0 and local_amount(spent_today) >= budget_daily and self.budget_day != day:
            self.budget_day = day
            if not first and enabled:
                desktop_notify(
                    text('notify_goal'),
                    text(
                        'notify_goal_body',
                        spent=f'{symbol} {text.number(local_amount(spent_today), 2)}',
                        goal=f'{symbol} {text.number(budget_daily, 2)}',
                    ),
                )

        budget_monthly = options.get('budget_monthly') or 0
        month_key = datetime.now().strftime('%Y-%m')
        month_usd = ((state.get('usage') or {}).get('last30') or {}).get('costUsd')
        if (
            budget_monthly > 0
            and isinstance(month_usd, (int, float))
            and local_amount(month_usd) >= budget_monthly
            and self.budget_month != month_key
        ):
            self.budget_month = month_key
            if not first and enabled:
                desktop_notify(
                    text('notify_goal_month'),
                    text(
                        'notify_goal_body',
                        spent=f'{symbol} {text.number(local_amount(month_usd), 2)}',
                        goal=f'{symbol} {text.number(budget_monthly, 2)}',
                    ),
                )

        for provider in providers:
            if provider.get('status') != 'ok':
                continue
            for window in provider.get('windows') or []:
                if not isinstance(window, dict) or not isinstance(window.get('usedPct'), (int, float)):
                    continue
                key = f"{provider['id']}/{window.get('group') or ''}/{window.get('label') or window.get('kind')}"
                before = self.windows.get(key)
                over = window['usedPct'] > crit
                self.windows[key] = {'over': over, 'pct': window['usedPct']}
                if first or not enabled or not before or before['over'] == over:
                    continue
                name = ' · '.join(
                    str(part) for part in (provider.get('label') or provider['id'], window.get('group'), window.get('label')) if part
                )
                if over:
                    desktop_notify(
                        text('notify_over', name=name, pct=window['usedPct']),
                        text('notify_over_body', crit=crit),
                    )
                elif window['usedPct'] < before['pct']:
                    desktop_notify(text('notify_freed', name=name), f"{window['usedPct']}%")


def load_state(state_path):
    try:
        with open(state_path, encoding='utf-8') as file:
            state = json.load(file)
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) and isinstance(state.get('providers'), list) else None


class View:
    """O que a bandeja mostra, calculado a partir do estado (sem D-Bus)."""

    def __init__(self, state, options, now=None):
        self.state = state
        self.options = options
        hidden = set(options.get('hidden_providers') or [])
        if state and isinstance(state.get('providers'), list) and hidden:
            state = {**state, 'providers': [p for p in state['providers'] if p.get('id') not in hidden]}
            self.state = state
        self.now = time.time() if now is None else now
        self.t = Text(options['language'])
        providers = [p for p in (state or {}).get('providers', []) if isinstance(p, dict) and p.get('id')]
        self.providers = providers
        self.with_data = [p for p in providers if worst_used(p) is not None]

    def shown(self, used):
        return 100 - used if self.options['show_remaining'] else used

    def level(self, provider):
        return level_of(provider, self.options['warn'], self.options['crit'])

    def critical(self):
        if not self.with_data:
            return None
        return max(self.with_data, key=lambda p: (LEVEL_ORDER.index(self.level(p)), worst_used(p)))

    def overall_level(self):
        worst = self.critical()
        return self.level(worst) if worst else 'off'

    def ring_number(self):
        worst = self.critical()
        return self.shown(worst_used(worst)) if worst else None

    def ring_fraction(self):
        worst = self.critical()
        return self.shown(worst_used(worst)) / 100 if worst else None

    def label(self):
        mode = self.options['label']
        if mode == 'none' or not self.with_data:
            return '' if mode == 'none' else '—'
        chosen = self.with_data if mode == 'all' else [self.critical()]
        return '  '.join(f"{p.get('label', p['id'])} {self.shown(worst_used(p))}%" for p in chosen)

    def header(self):
        if self.state is None:
            return self.t('no_data')
        updated = parse_time(self.state.get('updatedAt'))
        if updated is None or self.now - updated > STALE_AFTER_S:
            return self.t('stale')
        return 'TokenBar · ' + self.t('updated', age=self.t.age(self.now - updated))

    def tooltip(self):
        lines = []
        for provider in self.providers:
            used = worst_used(provider)
            value = '—' if used is None else f"{self.shown(used)}% {self.t('remaining' if self.options['show_remaining'] else 'used')}"
            line = f"{provider.get('name', provider['id'])}: {value}"
            if provider.get('error'):
                line += f" — {provider['error']}"
            lines.append(line)
        return '\n'.join(lines) or self.t('no_data')

    def account_lines(self, provider):
        """Linhas do submenu de uma conta."""
        lines = []
        for window in provider.get('windows') or []:
            if not isinstance(window, dict) or not isinstance(window.get('usedPct'), (int, float)):
                continue
            name = ' '.join(str(part) for part in (window.get('group'), window.get('label') or window.get('kind')) if part)
            reset = self.t.reset(window.get('resetsAt'), self.now)
            lines.append(f"{name}: {self.shown(window['usedPct'])}%" + (f' · {reset}' if reset else ''))
        if isinstance(provider.get('tokensToday'), (int, float)):
            line = self.t('tokens_today', tokens=self.t.tokens(provider['tokensToday']))
            if isinstance(provider.get('costTodayUsd'), (int, float)):
                line += ' ≈ ' + self.t.money(provider['costTodayUsd'], self.state.get('fx'), self.options['currency'])
            lines.append(line)
        if provider.get('error'):
            lines.append(str(provider['error']))
        return lines

    def account_title(self, provider):
        used = worst_used(provider)
        value = '—' if used is None else f'{self.shown(used)}%'
        dot = {'ok': '🟢', 'warn': '🟡', 'crit': '🔴', 'off': '⚪'}[self.level(provider)]
        return f"{dot} {provider.get('label', provider['id'])} · {provider.get('name', provider['id'])} — {value}"

    def summary(self):
        priced = [p for p in self.providers if isinstance(p.get('costTodayUsd'), (int, float))]
        if not priced:
            return None
        cost = sum(p['costTodayUsd'] for p in priced)
        tokens = sum(p.get('tokensToday') or 0 for p in self.providers if isinstance(p.get('tokensToday'), (int, float)))
        return self.t('cost_today', cost=self.t.money(cost, self.state.get('fx'), self.options['currency']), tokens=self.t.tokens(tokens))

    def update_line(self):
        update = (self.state or {}).get('update')
        if isinstance(update, dict) and update.get('available'):
            return self.t('update', version=update.get('latest') or '')
        return None


# ---------------------------------------------------------------- ícone


# Algarismos em bitmap (sem depender de fontes nem do cairo): 5x7 para dois
# dígitos e 3x5 para "100" e para ícones pequenos (16 px), onde o 5x7 encosta no anel.
DIGITS_5X7 = {
    '0': ('01110', '10001', '10011', '10101', '11001', '10001', '01110'),
    '1': ('00100', '01100', '00100', '00100', '00100', '00100', '01110'),
    '2': ('01110', '10001', '00001', '00010', '00100', '01000', '11111'),
    '3': ('11110', '00001', '00001', '01110', '00001', '00001', '11110'),
    '4': ('00010', '00110', '01010', '10010', '11111', '00010', '00010'),
    '5': ('11111', '10000', '11110', '00001', '00001', '10001', '01110'),
    '6': ('00110', '01000', '10000', '11110', '10001', '10001', '01110'),
    '7': ('11111', '00001', '00010', '00100', '01000', '01000', '01000'),
    '8': ('01110', '10001', '10001', '01110', '10001', '10001', '01110'),
    '9': ('01110', '10001', '10001', '01111', '00001', '00010', '01100'),
}
DIGITS_3X5 = {
    '0': ('111', '101', '101', '101', '111'), '1': ('010', '110', '010', '010', '111'),
    '2': ('111', '001', '111', '100', '111'), '3': ('111', '001', '011', '001', '111'),
    '4': ('101', '101', '111', '001', '001'), '5': ('111', '100', '111', '001', '111'),
    '6': ('111', '100', '111', '101', '111'), '7': ('111', '001', '010', '010', '010'),
    '8': ('111', '101', '111', '101', '111'), '9': ('111', '101', '111', '001', '111'),
}


def number_mask(text, size):
    """Cobertura (0..1) de cada pixel do número centralizado num ícone size x size."""
    font = DIGITS_5X7 if len(text) <= 2 and size >= 20 else DIGITS_3X5
    glyph_w, glyph_h = len(font['0'][0]), len(font['0'])
    scale = max(1, round(size / 22))
    width = (len(text) * (glyph_w + 1) - 1) * scale
    height = glyph_h * scale
    left, top = (size - width) // 2, (size - height) // 2
    mask = {}
    for index, char in enumerate(text):
        rows = font.get(char)
        if rows is None:
            continue
        for gy, row in enumerate(rows):
            for gx, bit in enumerate(row):
                if bit != '1':
                    continue
                for sy in range(scale):
                    for sx in range(scale):
                        x = left + (index * (glyph_w + 1) + gx) * scale + sx
                        mask[(x, top + gy * scale + sy)] = 1.0
    return mask


def ring_pixmap(size, fraction, level, number=None):
    """Anel de progresso em ARGB32 com bytes em ordem de rede, como o protocolo
    pede. Com `number`, o percentual vai escrito dentro do anel — para os
    desktops (KDE, Xfce, Cinnamon) que não mostram texto ao lado do ícone."""
    red, green, blue = COLORS[level]
    pixels = bytearray(size * size * 4)
    center = (size - 1) / 2
    outer = size / 2 - 0.5
    inner = outer - (max(1.5, size * 0.12) if number is not None else max(2.0, size * 0.2))
    sweep = None if fraction is None else max(0.0, min(1.0, fraction)) * 2 * math.pi
    text = number_mask(str(number), size) if number is not None else {}
    for y in range(size):
        for x in range(size):
            if (x, y) in text:
                offset = (y * size + x) * 4
                pixels[offset:offset + 4] = bytes((255, red, green, blue))
                continue
            dx, dy = x - center, y - center
            distance = math.hypot(dx, dy)
            # Borda suavizada: cobertura do pixel pelo anel.
            coverage = max(0.0, min(1.0, outer - distance + 0.5)) * max(0.0, min(1.0, distance - inner + 0.5))
            if coverage <= 0:
                if number is not None and distance < inner:
                    # Miolo escuro, como no logo: o número fica legível em barra clara ou escura.
                    offset = (y * size + x) * 4
                    pixels[offset:offset + 4] = bytes((255, *DISC))
                continue
            angle = (math.atan2(dx, -dy)) % (2 * math.pi)  # 0 no topo, sentido horário
            filled = sweep is not None and angle <= sweep
            # Como o logo: arco colorido sobre trilho grafite. Sem nada restante
            # e no vermelho, o trilho fica avermelhado para o alerta não sumir.
            if filled:
                color = (red, green, blue)
            elif level == 'crit' and (fraction or 0) < 0.02:
                color = tuple(round(t * 0.5 + c * 0.5) for t, c in zip(TRACK, COLORS['crit']))
            else:
                color = TRACK
            offset = (y * size + x) * 4
            pixels[offset:offset + 4] = bytes((round(coverage * 255), *color))
    return size, size, bytes(pixels)


# ---------------------------------------------------------------- D-Bus

ITEM_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="XAyatanaLabel" type="s" access="read"/>
    <property name="XAyatanaLabelGuide" type="s" access="read"/>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="ProvideXdgActivationToken"><arg name="token" type="s" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
    <signal name="XAyatanaNewLabel"><arg name="label" type="s"/><arg name="guide" type="s"/></signal>
  </interface>
</node>"""

MENU_XML = """
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg type="i" name="parentId" direction="in"/><arg type="i" name="recursionDepth" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="u" name="revision" direction="out"/><arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg type="ai" name="ids" direction="in"/><arg type="as" name="propertyNames" direction="in"/>
      <arg type="a(ia{sv})" name="properties" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg type="i" name="id" direction="in"/><arg type="s" name="name" direction="in"/><arg type="v" name="value" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" name="id" direction="in"/><arg type="s" name="eventId" direction="in"/>
      <arg type="v" name="data" direction="in"/><arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg type="a(isvu)" name="events" direction="in"/><arg type="ai" name="idErrors" direction="out"/>
    </method>
    <method name="AboutToShow"><arg type="i" name="id" direction="in"/><arg type="b" name="needUpdate" direction="out"/></method>
    <method name="AboutToShowGroup">
      <arg type="ai" name="ids" direction="in"/><arg type="ai" name="updatesNeeded" direction="out"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})" name="updatedProps"/><arg type="a(ias)" name="removedProps"/></signal>
    <signal name="LayoutUpdated"><arg type="u" name="revision"/><arg type="i" name="parent"/></signal>
  </interface>
</node>"""


class MenuItem:
    def __init__(self, key, label='', enabled=True, action=None, separator=False, children=None):
        self.key = key
        self.label = label
        self.enabled = enabled
        self.action = action
        self.separator = separator
        self.children = children or []
        self.id = 0

    def properties(self):
        if self.separator:
            return {'type': GLib.Variant('s', 'separator')}
        props = {'label': GLib.Variant('s', self.label.replace('_', '__')), 'enabled': GLib.Variant('b', self.enabled)}
        if self.children:
            props['children-display'] = GLib.Variant('s', 'submenu')
        return props


class MenuIds:
    """Número fixo para cada item, guardado entre as atualizações do menu.

    O host da bandeja guarda os itens pelo número; se ele mudar a cada
    atualização, o menu aparece misturando itens velhos e novos."""

    def __init__(self):
        self._ids = {'root': 0}

    def __call__(self, key):
        if key not in self._ids:
            self._ids[key] = len(self._ids)
        return self._ids[key]


def build_menu(view, actions, ids=None):
    """Árvore do menu da bandeja a partir do que a View calcula."""
    ids = ids or MenuIds()
    items = [MenuItem('header', view.header(), enabled=False)]
    update = view.update_line()
    if update:
        items.append(MenuItem('update', '⬆ ' + update, action=actions['update']))
    items.append(MenuItem('separator-top', separator=True))
    for provider in view.providers:
        key = f"account:{provider['id']}"
        children = [MenuItem(f'{key}:line{n}', line, enabled=False) for n, line in enumerate(view.account_lines(provider))]
        items.append(MenuItem(key, view.account_title(provider), children=children))
    summary = view.summary()
    if summary:
        items.append(MenuItem('separator-summary', separator=True))
        items.append(MenuItem('summary', summary, enabled=False))
    items.append(MenuItem('separator-actions', separator=True))
    items.append(MenuItem('refresh', view.t('refresh'), action=actions['refresh']))
    items.append(MenuItem('about', view.t('about'), children=[
        MenuItem('about:site', view.t('site', name=AUTHOR), action=actions['site']),
        MenuItem('about:code', view.t('code'), action=actions['code']),
    ]))
    items.append(MenuItem('quit', view.t('quit'), action=actions['quit']))
    root = MenuItem('root', children=items)
    numbered = {}

    def number(item):
        item.id = ids(item.key)
        numbered[item.id] = item
        for child in item.children:
            number(child)

    number(root)
    return root, numbered


class Tray:
    def __init__(self, state_path, config_path, collector):
        self.state_path = state_path
        self.config_path = config_path
        self.collector = collector
        self.loop = GLib.MainLoop()
        self.connection = None
        self.bus_name = f'org.kde.StatusNotifierItem-{os.getpid()}-1'
        self.revision = 1
        self.view = None
        self.menu_root, self.menu_items = None, {}
        self.menu_ids = MenuIds()
        self.number_in_icon = 'GNOME' not in os.environ.get('XDG_CURRENT_DESKTOP', '').upper()
        self.dock_panel = None  # janela do modo "ícone na dock"
        self.panel = None  # janela GTK 4, criada no primeiro clique; False = indisponível
        self.alerts = AlertTracker()
        self.item_info = Gio.DBusNodeInfo.new_for_xml(ITEM_XML).interfaces[0]
        self.menu_info = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
        self.actions = {
            'refresh': self.refresh,
            'update': lambda: self.open_uri(((self.view.state or {}).get('update') or {}).get('url') or REPOSITORY_URL),
            'site': lambda: self.open_uri(AUTHOR_URL),
            'code': lambda: self.open_uri(REPOSITORY_URL),
            'quit': self.loop.quit,
        }
        self.reload()

    # ---- dados

    def reload(self):
        options = load_options(self.config_path)
        state = load_state(self.state_path)
        self.view = View(state, options)
        self.alerts.check(state, options, self.view.t)
        self.menu_root, self.menu_items = build_menu(self.view, self.actions, self.menu_ids)
        self.revision += 1
        if self.connection:
            self.emit_item('NewIcon')
            self.emit_item('NewToolTip')
            self.emit_item('XAyatanaNewLabel', GLib.Variant('(ss)', (self.view.label(), self.label_guide())))
            # Textos novos para os itens que o host já conhece, e a estrutura nova.
            updated = [(item.id, item.properties()) for item in self.menu_items.values()]
            self.connection.emit_signal(None, '/MenuBar', 'com.canonical.dbusmenu', 'ItemsPropertiesUpdated',
                                        GLib.Variant('(a(ia{sv})a(ias))', (updated, [])))
            self.connection.emit_signal(None, '/MenuBar', 'com.canonical.dbusmenu', 'LayoutUpdated',
                                        GLib.Variant('(ui)', (self.revision, 0)))
        if self.panel:
            self.panel.reload_if_visible()
        self.apply_dock()
        return True

    def label_guide(self):
        return 'CLD2 100%' if self.view.options['label'] == 'critical' else ''

    def refresh(self):
        try:
            subprocess.Popen([self.collector, '--once'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass

    @staticmethod
    def open_uri(uri):
        try:
            Gio.AppInfo.launch_default_for_uri(uri, None)
        except GLib.Error:
            pass

    # ---- D-Bus: item

    def emit_item(self, name, params=None):
        self.connection.emit_signal(None, '/StatusNotifierItem', 'org.kde.StatusNotifierItem', name, params)

    def item_property(self, _conn, _sender, _path, _iface, name):
        view = self.view
        if name == 'Category':
            return GLib.Variant('s', 'ApplicationStatus')
        if name == 'Id':
            return GLib.Variant('s', 'tokenbar')
        if name == 'Title':
            return GLib.Variant('s', 'TokenBar')
        if name == 'Status':
            # Sempre "Active": com "NeedsAttention" o host troca o ícone pelo de
            # atenção (e alguns piscam). O alerta já está na cor do anel.
            return GLib.Variant('s', 'Active')
        if name == 'WindowId':
            return GLib.Variant('i', 0)
        if name in ('IconName', 'AttentionIconName'):
            return GLib.Variant('s', '')
        if name == 'IconPixmap':
            # Só o GNOME (extensão AppIndicator) mostra o texto ao lado do ícone;
            # nos outros desktops o percentual vai dentro do anel.
            number = view.ring_number() if self.number_in_icon and view.options['label'] != 'none' else None
            return GLib.Variant('a(iiay)', [ring_pixmap(size, view.ring_fraction(), view.overall_level(), number) for size in (16, 22, 24, 32, 48)])
        if name == 'ToolTip':
            return GLib.Variant('(sa(iiay)ss)', ('', [], 'TokenBar', view.tooltip()))
        if name == 'ItemIsMenu':
            # Com a janela do painel disponível, o clique a abre; o menu fica no botão direito.
            return GLib.Variant('b', self.panel_window() is None)
        if name == 'Menu':
            return GLib.Variant('o', '/MenuBar')
        if name == 'XAyatanaLabel':
            return GLib.Variant('s', view.label())
        if name == 'XAyatanaLabelGuide':
            return GLib.Variant('s', self.label_guide())
        return None

    def item_method(self, _conn, _sender, _path, _iface, method, params, invocation):
        # Wayland: quem clicou (a barra do KDE, o atalho do menu) passa um
        # "token" que permite ao painel vir para a frente com foco.
        if method == 'ProvideXdgActivationToken':
            self.activation_token = params.unpack()[0]
            invocation.return_value(None)
            return
        token, self.activation_token = getattr(self, 'activation_token', None), None
        for panel in (self.dock_panel, self.panel):
            if token and panel:
                panel.window.set_startup_id(token)
        # Clique: abre o mesmo painel do GNOME; sem GTK 4 o host mostra o menu.
        if method == 'Activate' and self.dock_panel:
            GLib.idle_add(lambda: (self.dock_panel.toggle(), False)[1])
        elif method == 'Activate' and self.panel_window() is not None:
            x, y = params.unpack()
            GLib.idle_add(lambda: (self.panel.toggle(x, y), False)[1])
        invocation.return_value(None)

    def apply_dock(self):
        """Opção "Ícone na dock": um TokenBar comum na barra de baixo, só com a logo."""
        wanted = self.view.options['dock']
        if wanted and self.dock_panel is None and not getattr(self, 'dock_failed', False):
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                import tokenbar_window
                self.dock_panel = tokenbar_window.PanelWindow(self.state_path, self.config_path, self.collector, dock=True)
                self.dock_panel.start_minimized()
            except Exception as error:  # GTK 4 ausente ou sem tela
                print(f'tokenbar: ícone na dock indisponível: {error}', file=sys.stderr)
                self.dock_panel = None
                self.dock_failed = True  # tenta uma vez só, sem encher o log
        elif not wanted and self.dock_panel is not None:
            self.dock_panel.window.destroy()
            self.dock_panel = None
        elif self.dock_panel:
            self.dock_panel.reload_if_visible()

    def panel_window(self):
        if self.panel is False:
            return None
        if self.panel is None:
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                import tokenbar_window
                self.panel = tokenbar_window.PanelWindow(self.state_path, self.config_path, self.collector)
            except Exception:  # GTK 4 ausente ou sem tela: fica só o menu nativo.
                self.panel = False
                return None
        return self.panel

    # ---- D-Bus: menu

    def layout(self, item, depth):
        # Cada filho entra no "av" como a própria variante (ia{sv}av); o
        # PyGObject a embrulha em "v" sozinho.
        children = [self.layout(child, depth - 1) for child in item.children] if depth != 0 else []
        return GLib.Variant('(ia{sv}av)', (item.id, item.properties(), children))

    def menu_property(self, _conn, _sender, _path, _iface, name):
        return {
            'Version': GLib.Variant('u', 3),
            'TextDirection': GLib.Variant('s', 'ltr'),
            'Status': GLib.Variant('s', 'normal'),
            'IconThemePath': GLib.Variant('as', []),
        }.get(name)

    def menu_method(self, _conn, _sender, _path, _iface, method, params, invocation):
        args = params.unpack()
        if method == 'GetLayout':
            parent = self.menu_items.get(args[0], self.menu_root)
            invocation.return_value(GLib.Variant.new_tuple(GLib.Variant('u', self.revision), self.layout(parent, args[1])))
        elif method == 'GetGroupProperties':
            ids = args[0] or list(self.menu_items)
            result = [(i, self.menu_items[i].properties()) for i in ids if i in self.menu_items]
            invocation.return_value(GLib.Variant('(a(ia{sv}))', (result,)))
        elif method == 'GetProperty':
            item = self.menu_items.get(args[0])
            value = item.properties().get(args[1]) if item else None
            invocation.return_value(GLib.Variant('(v)', (value or GLib.Variant('s', ''),)))
        elif method == 'Event':
            self.on_event(args[0], args[1])
            invocation.return_value(None)
        elif method == 'EventGroup':
            for item_id, event, _data, _time in args[0]:
                self.on_event(item_id, event)
            invocation.return_value(GLib.Variant('(ai)', ([],)))
        elif method == 'AboutToShow':
            invocation.return_value(GLib.Variant('(b)', (False,)))
        elif method == 'AboutToShowGroup':
            invocation.return_value(GLib.Variant('(aiai)', ([], [])))
        else:
            invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', method)

    def on_event(self, item_id, event):
        item = self.menu_items.get(item_id)
        if event == 'clicked' and item and item.action:
            GLib.idle_add(lambda: (item.action(), False)[1])

    # ---- ciclo de vida

    def on_bus(self, connection, _name):
        self.connection = connection
        # register_object foi marcado como obsoleto no PyGObject recente.
        register = getattr(connection, 'register_object_with_closures2', None) or connection.register_object
        register('/StatusNotifierItem', self.item_info, self.item_method, self.item_property, None)
        register('/MenuBar', self.menu_info, self.menu_method, self.menu_property, None)

    def on_name(self, _connection, _name):
        # O host da bandeja pode subir depois de nós; registramos sempre que ele aparece.
        Gio.bus_watch_name(Gio.BusType.SESSION, 'org.kde.StatusNotifierWatcher', Gio.BusNameWatcherFlags.NONE,
                           lambda conn, *_: self.register(conn), None)

    def register(self, connection):
        connection.call('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                        'RegisterStatusNotifierItem', GLib.Variant('(s)', (self.bus_name,)), None,
                        Gio.DBusCallFlags.NONE, -1, None, None)

    def run(self):
        Gio.bus_own_name(Gio.BusType.SESSION, self.bus_name, Gio.BusNameOwnerFlags.NONE,
                         self.on_bus, self.on_name, lambda *_: self.loop.quit())
        # Nome fixo: o atalho do menu/dock (tokenbar-open) chama o Activate daqui.
        Gio.bus_own_name(Gio.BusType.SESSION, APP_ID + '.Tray', Gio.BusNameOwnerFlags.NONE, None, None, None)
        GLib.idle_add(lambda: (self.apply_dock(), False)[1])
        # Dados novos (state.json) e opções novas (config.json) valem na hora.
        self.monitors = []
        for path in (self.state_path, self.config_path):
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                monitor = Gio.File.new_for_path(os.path.dirname(path)).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, None)
                monitor.connect('changed', lambda *_: self.reload())
                self.monitors.append(monitor)
            except (GLib.Error, OSError):
                pass
        GLib.timeout_add_seconds(POLL_SECONDS, self.reload)
        self.loop.run()


def default_paths(env=os.environ):
    home = os.path.expanduser('~')
    cache = env.get('XDG_CACHE_HOME') or os.path.join(home, '.cache')
    config = env.get('XDG_CONFIG_HOME') or os.path.join(home, '.config')
    return (os.path.join(cache, 'tokenbar', 'state.json'),
            os.path.join(config, 'tokenbar', 'config.json'),
            os.path.join(home, '.local', 'bin', 'tokenbar-collector'))


APP_ID = 'io.github.diogobritodesign.TokenBar'


def main():
    # Mesmo id do atalho instalado: a barra de baixo mostra a logo do TokenBar.
    GLib.set_prgname(APP_ID)
    GLib.set_application_name('TokenBar')
    state_path, config_path, collector = default_paths()
    Tray(state_path, config_path, collector).run()
    return 0


if __name__ == '__main__':
    sys.exit(main())
