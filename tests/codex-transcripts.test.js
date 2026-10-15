import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { codexUsageToday } from '../collector/src/usage/codexTranscripts.js';
import { tempDir } from './helpers.js';

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

test('Codex: soma token_usage_record de hoje e deduplica por response_id', async (t) => {
  const root = await tempDir(t);
  const file = path.join(root, '2026', '10', '15', 'rollout.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const stamp = today.toISOString();
  await fs.writeFile(file, [
    line({
      type: 'session_meta',
      timestamp: stamp,
      payload: { session_id: 'sess-1', cwd: '/home/u/projeto-x', model: 'gpt-4o' }
    }),
    line({
      type: 'token_usage_record',
      timestamp: stamp,
      ordinal: 1,
      payload: {
        response_id: 'resp-1',
        session_id: 'sess-1',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0
        }
      }
    }),
    line({
      type: 'token_usage_record',
      timestamp: stamp,
      ordinal: 2,
      payload: {
        response_id: 'resp-1',
        session_id: 'sess-1',
        usage: {
          input_tokens: 2_000_000,
          cached_input_tokens: 800_000,
          cache_write_input_tokens: 100_000,
          output_tokens: 300_000,
          reasoning_output_tokens: 50_000
        }
      }
    })
  ].join(''));

  const usage = await codexUsageToday(root, { files: {} }, today);
  // A segunda linha (mesmo response_id) sobrescreve: 1.2M input sem cache + 350k out + 100k write + 800k read.
  assert.equal(usage.tokens, 1_200_000 + 350_000 + 100_000 + 800_000);
  assert.equal(usage.sessions[0].project, 'projeto-x');
  assert.equal(usage.models[0].model, 'gpt-4o');
  assert.ok(usage.costUsd > 0);
});
