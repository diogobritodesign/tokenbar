// Contas mostradas nas configurações enquanto o coletor ainda não informou
// quais existem nesta máquina (depois disso vale a lista dele, em `accounts`).
export const PROVIDERS = [
    {id: 'claude-main', label: 'CLD', name: 'Claude'},
    {id: 'codex', label: 'OAI', name: 'Codex / ChatGPT'},
    {id: 'cursor-ide', label: 'CUR', name: 'Cursor'},
    {id: 'antigravity', label: 'AG', name: 'Antigravity'},
    {id: 'copilot', label: 'GH', name: 'GitHub Copilot'},
];

// Opções das configurações: [valor gravado, chave do texto em lib/i18n.js].
export const LANGUAGE_MODES = [
    ['auto', 'lang.auto'],
    ['pt', 'lang.pt'],
    ['en', 'lang.en'],
];

export const BAR_MODES = [
    ['full', 'mode.full'],
    ['dots', 'mode.dots'],
    ['critical', 'mode.critical'],
];

export const DISPLAY_MODES = [
    ['remaining', 'display.remaining'],
    ['used', 'display.used'],
];

export const CURRENCIES = [
    ['brl', 'currency.brl'],
    ['usd', 'currency.usd'],
];

export const POSITIONS = [
    ['left', 'pos.left'],
    ['center', 'pos.center'],
    ['right', 'pos.right'],
];
