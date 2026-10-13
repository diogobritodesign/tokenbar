#!/usr/bin/env node
import fs from 'node:fs/promises';
import { backfillHistoryOnce, collectOnce, historyCsv, loadConfig } from '../src/collect.js';
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
    await collectOnce(config);
    return { config, ok: true };
  } catch (error) {
    console.error(`tokenbar: ${t('log.stateWrite', { code: error?.code || error?.name || 'error' })}`);
    return { config, ok: false };
  }
}

if (args.includes('--once')) {
  const { ok } = await cycle();
  process.exit(ok ? 0 : 1);
}

// A gravação é atômica (tmp + rename), então sair no meio de um ciclo é seguro.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

let backfilled = false;
for (;;) {
  const { config } = await cycle();
  if (!backfilled) {
    backfilled = true;
    await backfillHistoryOnce(config).catch(() => console.error(`tokenbar: history: ${t('log.backfill')}`));
    await cycle();
  }
  await new Promise((resolve) => setTimeout(resolve, config.intervalSec * 1000));
}
