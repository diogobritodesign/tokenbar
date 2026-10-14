import { t } from './i18n.js';
import { platform } from './platform/index.js';

export const NETWORK_TIMEOUT_MS = 10_000;
export const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;

// Erro com mensagem já pronta para a interface. Nunca carrega cabeçalhos,
// corpo de resposta ou qualquer coisa vinda da credencial.
export class CollectError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = extra.retryAfterMs ?? null;
  }
}

function retryAfterMs(response) {
  const seconds = Number(response.header('retry-after'));
  const fromHeader = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  return Math.min(Math.max(fromHeader, RATE_LIMIT_BACKOFF_MS), RATE_LIMIT_BACKOFF_MAX_MS);
}

export async function fetchJson(url, headers) {
  let response;
  try {
    response = await platform.request({ url, headers, timeoutMs: NETWORK_TIMEOUT_MS });
  } catch (error) {
    if (platform.env().TOKENBAR_DEBUG) platform.log(`tokenbar: debug: ${url.replace(/\?.*$/, '')}: ${error?.message} ${String(error?.stack ?? '').split('\n')[0]}`);
    throw new CollectError('error', t(error?.code === 'timeout' ? 'net.timeout' : 'net.offline'));
  }

  if (response.status === 401 || response.status === 403) {
    throw new CollectError('unauthorized', t('net.denied', { status: response.status }));
  }
  if (response.status === 429) {
    throw new CollectError('rate_limited', t('net.rateLimited'), {
      retryAfterMs: retryAfterMs(response)
    });
  }
  if (response.status < 200 || response.status > 299) {
    throw new CollectError('error', t('net.httpError', { status: response.status }));
  }
  try {
    return JSON.parse(response.text);
  } catch {
    throw new CollectError('error', t('net.badResponse'));
  }
}
