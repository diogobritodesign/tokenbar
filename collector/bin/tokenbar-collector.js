#!/usr/bin/env node
// Ponto de entrada no Node (serviço do systemd e linha de comando).
import { run } from '../src/cli.js';

// A gravação é atômica (tmp + rename), então sair no meio de um ciclo é seguro.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.exit(await run(process.argv.slice(2), { print: (text) => console.log(text) }));
