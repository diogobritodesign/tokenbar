// Funções puras de formatação e cálculo: não dependem do GNOME Shell, então
// também rodam (e são testadas) no Node.

import {numberSeparators, t} from './i18n.js';

export const EMPTY = '—';
// Projeção de ritmo: só com uso e tempo de janela suficientes para não chutar.
const PACE_MIN_PCT = 5;
const PACE_MIN_ELAPSED = 0.05;

export function decimal(value) {
    return value.toFixed(1).replace(/\.0$/, '').replace('.', numberSeparators()[0]);
}

export function formatTokens(count) {
    if (!Number.isFinite(count))
        return EMPTY;
    if (count >= 1e9)
        return `${decimal(count / 1e9)}B`;
    if (count >= 1e6)
        return `${decimal(count / 1e6)}M`;
    if (count >= 1e3)
        return `${decimal(count / 1e3)}k`;
    return String(Math.round(count));
}

// 1234.5 -> "1.234,50" em português, "1,234.50" em inglês
export function formatAmount(value) {
    const [decimalMark, thousandsMark] = numberSeparators();
    const [whole, cents] = value.toFixed(2).split('.');
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsMark)}${decimalMark}${cents}`;
}

export function formatDuration(ms) {
    const minutes = Math.round(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${mins}min`;
    return `${mins}min`;
}

export function formatReset(resetsAt, now) {
    const at = Date.parse(resetsAt);
    if (!Number.isFinite(at))
        return '';
    if (at - now < 30000)
        return t('reset.soon');
    return t('reset.in', {time: formatDuration(at - now)});
}

// Mantido o ritmo médio desde o início da janela, quando ela chega a 100%?
// Devolve o instante previsto, ou null se o reset vem antes (ou se ainda há
// pouco dado para projetar).
export function projectedExhaustion(window, now) {
    const reset = Date.parse(window.resetsAt);
    const minutes = Number(window.windowMinutes) ||
        (window.kind === 'session' ? 300
            : String(window.kind).startsWith('weekly') ? 10080
                : window.kind === 'monthly' ? 30 * 24 * 60
                    : 0);
    const used = window.usedPct;
    if (!Number.isFinite(reset) || !minutes || used < PACE_MIN_PCT || used >= 100)
        return null;
    const length = minutes * 60000;
    const elapsed = now - (reset - length);
    if (elapsed < length * PACE_MIN_ELAPSED || elapsed > length)
        return null;
    const at = now + elapsed * (100 - used) / used;
    return at < reset ? at : null;
}

export function formatAge(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60)
        return t('age.seconds', {n: seconds});
    if (seconds < 3600)
        return t('age.minutes', {n: Math.floor(seconds / 60)});
    if (seconds < 86400)
        return t('age.hours', {n: Math.floor(seconds / 3600)});
    return t('age.days', {n: Math.floor(seconds / 86400)});
}

export function windowsOf(provider) {
    return Array.isArray(provider.windows)
        ? provider.windows.filter(w => w && Number.isFinite(w.usedPct))
        : [];
}

// A janela mais restritiva da conta: o maior usedPct.
export function worstPct(provider) {
    const windows = windowsOf(provider);
    return windows.length ? Math.max(...windows.map(w => w.usedPct)) : null;
}

// Texto da linha de ritmo de uma janela, ou null se não há o que dizer.
export function paceOf(window, level, now) {
    if (level === 'off')
        return null;
    if (window.usedPct >= 100)
        return {text: t('pace.exhausted'), styleClass: 'tokenbar-pace-crit'};
    // Ritmo recente, medido pelo coletor, quando há amostras; senão a média
    // desde o início da janela.
    const recent = window.pace?.basis === 'recent';
    const parsed = recent ? Date.parse(window.pace.exhaustsAt) : NaN;
    const exhaustsAt = recent ? (Number.isFinite(parsed) && parsed > now ? parsed : null)
        : projectedExhaustion(window, now);
    if (exhaustsAt === null)
        return null;
    return {text: t('pace.runsOut', {time: formatDuration(exhaustsAt - now)}), styleClass: 'tokenbar-pace'};
}
