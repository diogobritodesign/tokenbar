import { home } from '../paths.js';
import { platform } from '../platform/index.js';
import { join } from '../util/path.js';
import { isDirectory } from '../files.js';
import { CollectError, fetchJson } from '../http.js';
import { t } from '../i18n.js';
import { claudeDailyHistory, claudeUsageToday } from '../usage/claudeTranscripts.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const hint = () => t('claude.hint');

// A conta padrão fica em ~/.claude. Contas extras são pastas ~/.claude-<nome>
// (as usadas com CLAUDE_CONFIG_DIR); cada uma vira CLD2, CLD3... em ordem
// alfabética, para o id não mudar entre execuções.
export async function discoverClaudeAccounts(homeDir = home()) {
  // Sem acesso à pasta pessoal, a lista vem vazia e fica só a conta padrão.
  const names = (await platform.readdir(homeDir)).filter((name) => name.startsWith('.claude-')).sort();
  const extras = [];
  for (const name of names) {
    const dir = join(homeDir, name);
    if (!(await isDirectory(dir))) continue;
    // Só conta como conta se tiver login ou conversas; ~/.claude-backup e afins ficam de fora.
    const hasLogin = await platform.exists(join(dir, '.credentials.json'));
    if (hasLogin || (await isDirectory(join(dir, 'projects')))) extras.push({ dir, suffix: name.slice('.claude-'.length) });
  }
  return [
    { id: 'claude-main', label: 'CLD', name: extras.length > 0 ? t('name.claudeMain') : 'Claude', dir: join(homeDir, '.claude') },
    ...extras.map((extra, index) => ({
      id: `claude-${index + 2}`,
      label: `CLD${index + 2}`,
      name: `Claude (${extra.suffix})`,
      dir: extra.dir
    }))
  ];
}

// Janelas extras por modelo que a API devolve além de five_hour/seven_day.
const SCOPED_WEEKLY = [
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet']
];

export function planLabel(oauth) {
  const type = String(oauth.subscriptionType || '').trim();
  if (!type) return null;
  const base = type.charAt(0).toUpperCase() + type.slice(1);
  const multiplier = /max_(\d+x)/i.exec(String(oauth.rateLimitTier || ''));
  return multiplier ? `${base} ${multiplier[1]}` : base;
}

// Somente leitura: o arquivo de credenciais nunca é alterado e o token
// expirado não é renovado aqui (isso é trabalho do próprio Claude Code).
async function readOauth(dir) {
  let parsed;
  try {
    parsed = JSON.parse(await platform.readText(join(dir, '.credentials.json')));
  } catch {
    throw new CollectError('unauthorized', t('claude.noCredentials', { hint: hint() }));
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken) throw new CollectError('unauthorized', t('claude.noCredentials', { hint: hint() }));
  return oauth;
}

function toWindow(kind, label, raw) {
  const windowMinutes = kind === 'session' ? 5 * 60 : 7 * 24 * 60;
  const used = Number(raw?.utilization);
  if (!raw || !Number.isFinite(used)) return null;
  const resetsAt = Date.parse(raw.resets_at);
  return {
    kind,
    label,
    windowMinutes,
    usedPct: Math.round(Math.min(Math.max(used, 0), 100)),
    resetsAt: Number.isFinite(resetsAt) ? new Date(Math.round(resetsAt / 1000) * 1000).toISOString().replace('.000Z', 'Z') : null
  };
}

export function mapWindows(usage) {
  const windows = [
    toWindow('session', '5h', usage?.five_hour),
    toWindow('weekly', t('label.week'), usage?.seven_day),
    ...SCOPED_WEEKLY.map(([key, label]) => toWindow('weekly-model', label, usage?.[key]))
  ];
  return windows.filter(Boolean);
}

function claudeProvider(account) {
  return {
    id: account.id,
    label: account.label,
    name: account.name,
    exists: () => isDirectory(account.dir),

    async fetchLimits() {
      const oauth = await readOauth(account.dir);
      const plan = planLabel(oauth);
      if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now()) {
        throw Object.assign(new CollectError('unauthorized', t('claude.expired', { hint: hint() })), { plan });
      }
      let usage;
      try {
        usage = await fetchJson(USAGE_URL, {
          accept: 'application/json',
          authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': 'tokenbar/0.1'
        });
      } catch (error) {
        if (error instanceof CollectError && error.status === 'unauthorized') {
          error.message = t('claude.refused', { hint: hint() });
        }
        throw Object.assign(error, { plan });
      }
      return { plan, windows: mapWindows(usage) };
    },

    usageToday: (usageCache, now) => claudeUsageToday(join(account.dir, 'projects'), usageCache, now),
    dailyHistory: (sinceMs) => claudeDailyHistory(join(account.dir, 'projects'), sinceMs)
  };
}

export async function claudeProviders() {
  return (await discoverClaudeAccounts()).map(claudeProvider);
}
