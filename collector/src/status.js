import { readJson, writeJsonAtomic } from './files.js';
import { fetchJson } from './http.js';
import { STATUS_CACHE_FILE } from './paths.js';

const REFRESH_MS = 5 * 60 * 1000;

// Páginas públicas de status (formato Statuspage). Nenhuma credencial vai junto.
const PAGES = [{ id: 'claude', name: 'Claude', url: 'https://status.claude.com/api/v2/status.json' }];

// indicator: none | minor | major | critical (ou null se a página não respondeu).
export async function serviceStatus(now = Date.now()) {
  const cached = await readJson(STATUS_CACHE_FILE);
  if (Array.isArray(cached?.services) && Number.isFinite(cached.nextTryAt) && now < cached.nextTryAt) {
    return cached.services;
  }
  const services = await Promise.all(
    PAGES.map(async (page) => {
      try {
        const body = await fetchJson(page.url, { accept: 'application/json' });
        return {
          id: page.id,
          name: page.name,
          indicator: String(body?.status?.indicator || 'none'),
          description: String(body?.status?.description || '').slice(0, 120)
        };
      } catch {
        return { id: page.id, name: page.name, indicator: null, description: '' };
      }
    })
  );
  await writeJsonAtomic(STATUS_CACHE_FILE, { services, nextTryAt: now + REFRESH_MS }).catch(() => {});
  return services;
}
