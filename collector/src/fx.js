import { readJson, writeJsonAtomic } from './files.js';
import { fetchJson } from './http.js';
import { fxCacheFile } from './paths.js';

const REFRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;

// Duas fontes públicas, sem chave; nenhum dado seu é enviado a elas.
const SOURCES = [
  ['https://economia.awesomeapi.com.br/json/last/USD-BRL', (body) => Number(body?.USDBRL?.bid)],
  ['https://open.er-api.com/v6/latest/USD', (body) => Number(body?.rates?.BRL)]
];

// Cotação do dólar em reais, renovada no máximo duas vezes por dia. Sem rede,
// fica a última conhecida; sem nenhuma, devolve null e o painel mostra em US$.
export async function usdBrlRate(now = Date.now()) {
  const cached = await readJson(fxCacheFile());
  const known = Number.isFinite(cached?.usdBrl) ? { usdBrl: cached.usdBrl, asOf: cached.asOf } : null;
  if (Number.isFinite(cached?.nextTryAt) && now < cached.nextTryAt) return known;

  for (const [url, pick] of SOURCES) {
    try {
      const rate = pick(await fetchJson(url, { accept: 'application/json' }));
      if (Number.isFinite(rate) && rate > 0) {
        const fresh = { usdBrl: rate, asOf: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') };
        await writeJsonAtomic(fxCacheFile(), { ...fresh, nextTryAt: now + REFRESH_MS });
        return fresh;
      }
    } catch {
      // tenta a próxima fonte
    }
  }
  await writeJsonAtomic(fxCacheFile(), { ...(known || {}), nextTryAt: now + RETRY_MS }).catch(() => {});
  return known;
}
