import { home } from './paths.js';
import { platform } from './platform/index.js';
import { discoverClaudeAccounts } from './providers/claude.js';
import { join } from './util/path.js';

// Pastas onde as ferramentas gravam as conversas enquanto você usa.
export async function activityPaths(homeDir = home()) {
  const accounts = await discoverClaudeAccounts(homeDir);
  return [
    ...accounts.map((account) => join(account.dir, 'projects')),
    join(homeDir, '.codex', 'sessions'),
    // Transcripts do agente do Cursor (disparo de coleta após uso).
    join(homeDir, '.cursor', 'projects')
  ];
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
  return platform.watchTree(paths, (file) => {
    if (!file || file.endsWith('.jsonl')) onActivity();
  });
}
