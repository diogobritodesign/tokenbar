import { watch } from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.js';
import { discoverClaudeAccounts } from './providers/claude.js';

// Pastas onde as ferramentas gravam as conversas enquanto você usa.
export async function activityPaths(home = HOME) {
  const accounts = await discoverClaudeAccounts(home);
  return [...accounts.map((account) => path.join(account.dir, 'projects')), path.join(home, '.codex', 'sessions')];
}

// Agenda a próxima coleta: no intervalo normal quando nada acontece, ou logo
// depois de um uso (quando as ferramentas gravam conversa), respeitando um
// espaço mínimo entre consultas para não esbarrar no limite das APIs.
export class CollectionScheduler {
  constructor({ minGapMs = 60_000, settleMs = 10_000, now = () => Date.now() } = {}) {
    this.minGapMs = minGapMs;
    this.settleMs = settleMs;
    this.now = now;
    this.lastRunAt = 0;
    this.dueAt = 0;
    this._timer = null;
    this._wake = null;
  }

  // Marca o fim de uma coleta e agenda a próxima pelo intervalo normal.
  ran(intervalMs) {
    this.lastRunAt = this.now();
    this.dueAt = this.lastRunAt + intervalMs;
  }

  // Houve uso: antecipa a próxima coleta, sem passar do espaço mínimo.
  activity() {
    const soon = Math.max(this.lastRunAt + this.minGapMs, this.now() + this.settleMs);
    if (soon < this.dueAt) {
      this.dueAt = soon;
      this._arm();
    }
  }

  // Resolve quando chegar a hora da próxima coleta.
  wait() {
    return new Promise((resolve) => {
      this._wake = resolve;
      this._arm();
    });
  }

  _arm() {
    if (!this._wake) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const wake = this._wake;
      this._wake = null;
      wake();
    }, Math.max(0, this.dueAt - this.now()));
  }
}

// Observa as pastas de conversa e avisa o agendador a cada arquivo .jsonl
// alterado. Pasta que não existe é ignorada; o resto continua valendo.
export function watchActivity(paths, onActivity) {
  const watchers = [];
  for (const dir of paths) {
    try {
      const watcher = watch(dir, { recursive: true, persistent: false }, (_event, file) => {
        if (!file || String(file).endsWith('.jsonl')) onActivity();
      });
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch {
      // pasta ausente ou sem permissão
    }
  }
  return () => watchers.forEach((watcher) => watcher.close());
}
