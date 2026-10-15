// Texto curto do estado para barras de outros ambientes (Waybar, Polybar),
// lido do state.json que o coletor já grava. Não faz coleta.

const COLORS = { ok: '#7bea83', warn: '#ece38f', crit: '#ff7b72', off: '#8e8e93' };
const SOFT = ['ok', 'rate_limited', 'idle'];

function worstUsed(provider) {
  const used = (Array.isArray(provider?.windows) ? provider.windows : [])
    .map((window) => window?.usedPct)
    .filter((pct) => Number.isFinite(pct));
  return used.length ? Math.max(...used) : null;
}

export function levelOf(provider, { warn = 60, crit = 85 } = {}) {
  const used = worstUsed(provider);
  if (used === null || !SOFT.includes(provider.status)) return 'off';
  if (used > Math.max(crit, warn)) return 'crit';
  if (used >= warn) return 'warn';
  return 'ok';
}

const LEVEL_ORDER = ['off', 'ok', 'warn', 'crit'];

// Contas com dado, na ordem do state.json, e a mais crítica entre elas.
function summarize(state, options) {
  const hidden = new Set(
    (Array.isArray(options.hiddenProviders) ? options.hiddenProviders : []).map(String)
  );
  const providers = (Array.isArray(state?.providers) ? state.providers : [])
    .filter((provider) => provider && worstUsed(provider) !== null && !hidden.has(provider.id));
  const items = providers.map((provider) => {
    const used = worstUsed(provider);
    return {
      label: String(provider.label ?? provider.id),
      name: String(provider.name ?? provider.id),
      used,
      shown: options.showRemaining ? 100 - used : used,
      level: levelOf(provider, options),
      error: provider.error ? String(provider.error) : null
    };
  });
  const worst = items.reduce(
    (a, b) =>
      LEVEL_ORDER.indexOf(b.level) > LEVEL_ORDER.indexOf(a.level) ||
      (b.level === a.level && b.used > a.used)
        ? b
        : a,
    items[0] ?? null
  );
  const labelMode = ['critical', 'all', 'none'].includes(options.label) ? options.label : 'all';
  let shown = items;
  if (labelMode === 'none') shown = [];
  else if (labelMode === 'critical' && worst) shown = [worst];
  return { items, shown, worst };
}

// Objeto no formato "return-type": "json" da Waybar.
export function waybarOutput(state, options = {}) {
  const opts = { showRemaining: true, label: 'all', ...options };
  const { items, shown, worst } = summarize(state, opts);
  if (!worst) return { text: 'TokenBar —', tooltip: 'TokenBar: no data', class: 'off', percentage: 0 };
  const text = shown.length === 0
    ? 'TokenBar'
    : shown.map((item) => `${item.label} ${item.shown}%`).join('  ');
  return {
    text,
    tooltip: items
      .map((item) => `${item.name}: ${item.shown}%${item.error ? ` — ${item.error}` : ''}`)
      .join('\n'),
    class: worst.level,
    percentage: worst.used
  };
}

// Uma linha para a Polybar, com as cores no formato %{F#rrggbb}.
export function polybarOutput(state, options = {}) {
  const opts = { showRemaining: true, colors: true, label: 'all', ...options };
  const { shown, worst } = summarize(state, opts);
  if (!worst) return 'TokenBar —';
  if (shown.length === 0) return 'TokenBar';
  return shown
    .map((item) => {
      const text = `${item.label} ${item.shown}%`;
      return opts.colors ? `%{F${COLORS[item.level]}}●%{F-} ${text}` : text;
    })
    .join('  ');
}
