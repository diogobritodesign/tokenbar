// Linha de comando do coletor, igual no Node e no GJS. `io` traz o que muda
// entre os dois: imprimir e sair.
import { CollectionScheduler, activityPaths, watchActivity } from './activity.js';
import { polybarOutput, waybarOutput } from './bar.js';
import { backfillHistoryOnce, collectOnce, historyCsv, loadConfig } from './collect.js';
import { readJson } from './files.js';
import { setLanguage, t } from './i18n.js';
import { stateFile } from './paths.js';
import { platform } from './platform/index.js';

// Devolve o código de saída; no modo serviço (sem argumentos) não retorna.
export async function run(args, io) {
  setLanguage((await loadConfig()).language);

  if (args.includes('--help') || args.includes('-h')) {
    io.print(t('cli.help'));
    return 0;
  }

  // Saída para barras de outros ambientes: só lê o state.json e imprime.
  if (args.includes('--waybar') || args.includes('--polybar')) {
    const state = await readJson(stateFile());
    const config = await loadConfig();
    const options = {
      showRemaining: config.bar.showRemaining,
      warn: config.bar.warn,
      crit: config.bar.crit,
      label: config.bar.label,
      hiddenProviders: config.bar.hiddenProviders
    };
    io.print(args.includes('--waybar') ? JSON.stringify(waybarOutput(state, options)) : polybarOutput(state, options));
    return 0;
  }

  const exportIndex = args.indexOf('--export-csv');
  if (exportIndex !== -1) {
    const target = args[exportIndex + 1];
    if (!target) {
      platform.log(`tokenbar: ${t('cli.csvNeedsPath')}`);
      return 2;
    }
    try {
      await platform.writeText(target, await historyCsv(), 0o644);
      return 0;
    } catch (error) {
      platform.log(`tokenbar: ${t('cli.csvFailed', { code: error?.code || 'error' })}`);
      return 1;
    }
  }

  const forceOnce = args.includes('--once') || args.includes('--check-update');
  const cycle = async ({ forceProviders = false } = {}) => {
    const config = await loadConfig();
    try {
      await collectOnce(config, {
        forceUpdateCheck: args.includes('--check-update'),
        forceProviders
      });
      return { config, ok: true };
    } catch (error) {
      platform.log(`tokenbar: ${t('log.stateWrite', { code: error?.code || error?.name || 'error' })}`);
      return { config, ok: false };
    }
  };

  if (forceOnce) {
    const { ok } = await cycle({ forceProviders: true });
    return ok ? 0 : 1;
  }

  // Coleta no intervalo das configurações e, além disso, logo depois de cada
  // uso do Claude Code ou do Codex (no máximo uma vez por minuto).
  const scheduler = new CollectionScheduler();
  watchActivity(await activityPaths(), () => scheduler.activity());

  let backfilled = false;
  for (;;) {
    const { config } = await cycle();
    if (!backfilled) {
      backfilled = true;
      await backfillHistoryOnce(config).catch(() => platform.log(`tokenbar: history: ${t('log.backfill')}`));
      await cycle();
    }
    scheduler.ran(config.intervalSec * 1000);
    await scheduler.wait();
  }
}
