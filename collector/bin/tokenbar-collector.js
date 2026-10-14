#!/usr/bin/env node
import fs from 'node:fs/promises';
import { backfillHistoryOnce, collectOnce, historyCsv, loadConfig } from '../src/collect.js';
import { CollectionScheduler, activityPaths, watchActivity } from '../src/activity.js';
import { setLanguage, t } from '../src/i18n.js';

const args = process.argv.slice(2);
setLanguage((await loadConfig()).language);

if (args.includes('--help') || args.includes('-h')) {
  console.log(t('cli.help'));
  process.exit(0);
}

const exportIndex = args.indexOf('--export-csv');
if (exportIndex !== -1) {
  const target = args[exportIndex + 1];
  if (!target) {
    console.error(`tokenbar: ${t('cli.csvNeedsPath')}`);
    process.exit(2);
  }
  try {
    await fs.writeFile(target, await historyCsv());
    process.exit(0);
  } catch (error) {
    console.error(`tokenbar: ${t('cli.csvFailed', { code: error?.code || 'error' })}`);
    process.exit(1);
  }
}

async function cycle() {
  const config = await loadConfig();
  try {
    await collectOnce(config, { forceUpdateCheck: args.includes('--check-update') });
    return { config, ok: true };
  } catch (error) {
    console.error(`tokenbar: ${t('log.stateWrite', { code: error?.code || error?.name || 'error' })}`);
    return { config, ok: false };
  }
}

if (args.includes('--once') || args.includes('--check-update')) {
  const { ok } = await cycle();
  process.exit(ok ? 0 : 1);
}

// A gravação é atômica (tmp + rename), então sair no meio de um ciclo é seguro.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Coleta no intervalo das configurações e, além disso, logo depois de cada uso
// do Claude Code ou do Codex (no máximo uma vez por minuto).
const scheduler = new CollectionScheduler();
watchActivity(await activityPaths(), () => scheduler.activity());

let backfilled = false;
for (;;) {
  const { config } = await cycle();
  if (!backfilled) {
    backfilled = true;
    await backfillHistoryOnce(config).catch(() => console.error(`tokenbar: history: ${t('log.backfill')}`));
    await cycle();
  }
  scheduler.ran(config.intervalSec * 1000);
  await scheduler.wait();
}
