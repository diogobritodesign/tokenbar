import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './files.js';
import { fetchJson } from './http.js';
import { UPDATE_CACHE_FILE } from './paths.js';

export const REPOSITORY = 'diogobritodesign/tokenbar';
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const LATEST_URL = `https://api.github.com/repos/${REPOSITORY}/commits/main`;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;

// O install.sh grava ao lado do coletor qual versão foi instalada:
// { version, commit, installedAt }. Sem esse arquivo (rodando direto do
// repositório), não há como comparar e a checagem é pulada.
export async function installedVersion(file) {
  file ??= fileURLToPath(new URL('../VERSION.json', import.meta.url));
  const data = await readJson(file);
  if (!data || typeof data !== 'object') return null;
  return {
    version: typeof data.version === 'string' ? data.version : null,
    commit: typeof data.commit === 'string' && /^[0-9a-f]{7,40}$/.test(data.commit) ? data.commit : null,
    installedAt: Number.isFinite(Date.parse(data.installedAt)) ? data.installedAt : null
  };
}

// Há versão nova se o último commit publicado não é o instalado. Instalações
// feitas sem git (sem commit gravado) comparam pela data.
export function isNewer(installed, latest) {
  if (!installed || !latest?.sha) return false;
  if (installed.commit) return !latest.sha.startsWith(installed.commit);
  const published = Date.parse(latest.date);
  const installedAt = Date.parse(installed.installedAt);
  return Number.isFinite(published) && Number.isFinite(installedAt) && published > installedAt;
}

// Consulta o GitHub no máximo uma vez por dia (a API pública, sem login; nada
// sobre você vai na requisição). `force` ignora o intervalo, para o botão
// "procurar agora". Devolve o bloco `update` do state.json, ou null.
export async function checkForUpdate({ enabled, force = false, now = Date.now(), versionFile } = {}) {
  if (!enabled) return null;
  const installed = await installedVersion(versionFile);
  if (!installed) return null;

  const cached = await readJson(UPDATE_CACHE_FILE);
  let latest = cached?.latest ?? null;
  const due = force || !Number.isFinite(cached?.nextTryAt) || now >= cached.nextTryAt;
  if (due) {
    try {
      const body = await fetchJson(LATEST_URL, { accept: 'application/vnd.github+json', 'user-agent': 'tokenbar' });
      latest = {
        sha: String(body?.sha || ''),
        date: String(body?.commit?.committer?.date || ''),
        summary: String(body?.commit?.message || '').split('\n')[0].slice(0, 120)
      };
      await writeJsonAtomic(UPDATE_CACHE_FILE, { latest, nextTryAt: now + CHECK_EVERY_MS });
    } catch {
      await writeJsonAtomic(UPDATE_CACHE_FILE, { latest, nextTryAt: now + RETRY_MS }).catch(() => {});
    }
  }

  return {
    installed: installed.commit ? installed.commit.slice(0, 7) : installed.version,
    version: installed.version,
    available: isNewer(installed, latest),
    latest: latest?.sha ? latest.sha.slice(0, 7) : null,
    latestDate: latest?.date || null,
    summary: latest?.summary || null,
    url: installed.commit && latest?.sha ? `${REPOSITORY_URL}/compare/${installed.commit.slice(0, 7)}...${latest.sha.slice(0, 7)}` : `${REPOSITORY_URL}/commits/main`
  };
}
