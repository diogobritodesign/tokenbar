// Textos que o coletor grava no state.json e no journal, em português e inglês.
// O idioma vem do config.json (a extensão escreve lá o que está em uso); sem
// isso, das variáveis de ambiente do sistema.
export const MESSAGES = {
  'label.week': ['Semana', 'Week'],
  'label.code': ['Código', 'Code'],
  'name.claudeMain': ['Claude (principal)', 'Claude (main)'],
  'net.timeout': ['tempo esgotado (10 s)', 'timed out (10 s)'],
  'net.offline': ['sem conexão com o servidor', 'could not reach the server'],
  'net.denied': ['acesso negado (HTTP {status})', 'access denied (HTTP {status})'],
  'net.rateLimited': ['limite de requisições (HTTP 429)', 'rate limited (HTTP 429)'],
  'net.httpError': ['servidor respondeu HTTP {status}', 'server answered HTTP {status}'],
  'net.badResponse': ['resposta inválida do servidor', 'invalid response from the server'],
  'unexpected': ['falha inesperada', 'unexpected failure'],
  'claude.hint': ['abra o Claude Code para renovar o login', 'open Claude Code to renew the login'],
  'claude.noCredentials': ['sem credenciais — {hint}', 'no credentials — {hint}'],
  'claude.expired': ['login expirado — {hint}', 'login expired — {hint}'],
  'claude.refused': ['login recusado — {hint}', 'login refused — {hint}'],
  'codex.hint': ['rode "codex login" para entrar de novo', 'run "codex login" to sign in again'],
  'codex.noCredentials': ['sem credenciais — {hint}', 'no credentials — {hint}'],
  'codex.noChatgptLogin': ['sem login do ChatGPT — {hint}', 'no ChatGPT login — {hint}'],
  'codex.invalidLogin': ['login do Codex inválido — {hint}', 'Codex login is invalid — {hint}'],
  'codex.noLimits': ['o Codex não informou os limites', 'Codex did not report any limits'],
  'antigravity.closed': ['Antigravity fechado — mostrando o último valor', 'Antigravity is closed — showing the last known value'],
  'antigravity.noQuota': ['o Antigravity está aberto, mas não informou as cotas', 'Antigravity is open but did not report quotas'],
  'copilot.hint': ['rode "gh auth login"', 'run "gh auth login"'],
  'copilot.noGh': ['CLI "gh" não encontrada', '"gh" CLI not found'],
  'copilot.noLogin': ['GitHub sem login — {hint}', 'GitHub is not signed in — {hint}'],
  'copilot.noCopilot': ['esta conta do GitHub não tem Copilot', 'this GitHub account has no Copilot'],
  'copilot.ghFailed': ['a CLI "gh" falhou ao consultar o Copilot', 'the "gh" CLI failed to query Copilot'],
  'copilot.badResponse': ['resposta inválida do GitHub', 'invalid response from GitHub'],
  'copilot.noQuota': ['o Copilot não informou cotas', 'Copilot did not report any quotas'],
  'log.usageRead': ['falha ao ler o uso local', 'failed to read local usage'],
  'log.historyWrite': ['falha ao gravar o histórico', 'failed to write the history'],
  'log.cacheWrite': ['falha ao gravar o cache de uso', 'failed to write the usage cache'],
  'log.stateWrite': ['falha ao gravar o estado ({code})', 'failed to write the state ({code})'],
  'log.backfill': ['falha ao reconstruir os últimos dias', 'failed to rebuild the last days of history'],
  'cli.csvNeedsPath': ['--export-csv precisa do caminho do arquivo', '--export-csv needs a file path'],
  'cli.csvFailed': ['não foi possível gravar o CSV ({code})', 'could not write the CSV ({code})'],
  'cli.help': [
    'uso: tokenbar-collector [--once | --check-update | --export-csv ARQUIVO | --waybar | --polybar]\n\n  --once               coleta uma vez, grava state.json e sai\n  --check-update       como --once, procurando versão nova agora\n  --export-csv ARQUIVO grava o histórico diário em CSV e sai\n  --waybar, --polybar  imprime o estado para essas barras (só lê, não coleta)\n  (sem argumentos: fica em loop, no intervalo definido nas configurações)',
    'usage: tokenbar-collector [--once | --check-update | --export-csv FILE | --waybar | --polybar]\n\n  --once             collect once, write state.json and exit\n  --check-update     like --once, checking for a new version right away\n  --export-csv FILE  write the daily history as CSV and exit\n  --waybar, --polybar  print the state for those bars (read-only, no collection)\n  (no arguments: loop at the interval set in the settings)'
  ]
};

export const LANGUAGES = ['pt', 'en'];

// pt_BR.UTF-8, pt-PT, pt -> 'pt'; qualquer outra coisa -> 'en'.
export function languageFromLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export function systemLanguage(env = process.env) {
  return languageFromLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG);
}

let current = systemLanguage();

export function setLanguage(language) {
  current = LANGUAGES.includes(language) ? language : systemLanguage();
}

export function t(key, vars = {}) {
  const entry = MESSAGES[key];
  if (!entry) return key;
  return entry[LANGUAGES.indexOf(current)].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}
