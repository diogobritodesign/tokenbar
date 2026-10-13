import { readJson, writeJsonAtomic } from './files.js';
import { SAMPLES_FILE } from './paths.js';

const KEEP_MS = 26 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Fração da janela usada para medir o ritmo recente: 45 min numa janela de 5 h,
// limitado a 24 h numa janela semanal.
const LOOKBACK_FRACTION = 0.15;
const SAMPLE_EVERY_MS = 5 * 60 * 1000;
// Dois resets a menos de 5 min um do outro são a mesma janela (o servidor oscila alguns segundos).
const SAME_WINDOW_MS = 5 * 60 * 1000;

// Guarda uma amostra (instante, % usado) de cada janela a cada coleta e, com
// elas, projeta quando o limite acaba no ritmo dos últimos minutos/horas.
// Preenche `window.pace = { basis: 'recent', exhaustsAt }`; exhaustsAt é null
// quando, nesse ritmo, o reset chega antes. Sem amostras suficientes o campo
// não é criado e a interface cai na média da janela inteira.
export async function applyRecentPace(providers, now = Date.now()) {
  const stored = (await readJson(SAMPLES_FILE)) || {};
  const samples = {};

  for (const provider of providers) {
    if (provider.status !== 'ok') continue;
    for (const window of provider.windows) {
      const reset = Date.parse(window.resetsAt);
      const length = Number(window.windowMinutes) * 60000;
      if (!Number.isFinite(reset) || !(length > 0)) continue;

      const key = `${provider.id}/${window.group ?? ''}/${window.label}`;
      const history = (Array.isArray(stored[key]) ? stored[key] : []).filter(
        ([at, , sampleReset]) => now - at <= KEEP_MS && Math.abs(sampleReset - reset) < SAME_WINDOW_MS
      );
      const last = history.at(-1);
      if (!last || last[1] !== window.usedPct || now - last[0] >= SAMPLE_EVERY_MS) {
        history.push([now, window.usedPct, reset]);
      }
      samples[key] = history;

      const lookback = Math.min(length * LOOKBACK_FRACTION, MAX_LOOKBACK_MS);
      const base = history.find(([at]) => now - at <= lookback);
      const span = base ? now - base[0] : 0;
      if (span < lookback / 3) continue;

      const gained = window.usedPct - base[1];
      let exhaustsAt = null;
      if (gained > 0 && window.usedPct < 100) {
        const at = now + (span * (100 - window.usedPct)) / gained;
        if (at < reset) exhaustsAt = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      window.pace = { basis: 'recent', exhaustsAt };
    }
  }
  await writeJsonAtomic(SAMPLES_FILE, samples).catch(() => {});
}
