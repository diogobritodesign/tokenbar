import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Pasta temporária isolada por teste, apagada ao final.
export async function tempDir(t, prefix = 'tokenbar-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Linha de transcript do Claude Code com os campos que o coletor lê.
export function assistantLine({ id, at, model = 'claude-opus-5-5', usage, sessionId = 'sessao-1', cwd = '/home/u/projeto-a' }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    sessionId,
    cwd,
    message: { id, model, usage }
  });
}

export const usage = (input, output, cacheRead = 0, write5m = 0, write1h = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: write5m + write1h,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h }
});
