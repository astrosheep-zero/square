import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { readCodexBoundary, recordCodexBoundary } from '../dist/codex-boundary-state.js';
import { codexHookResponse, runCodexHookAsync } from '../dist/codex-hook.js';

test('Codex hook budgets cancel boundary record and clear while the lock stays held', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-hook-budget-'));
  const env = {
    ...process.env,
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json'),
    SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger'),
    SQUARE_CODEX_HOOK_BUDGET_MS: '60',
  };
  await recordCodexBoundary('thread', 'non-stop', env);
  const before = await readCodexBoundary('thread', env);
  const lock = new DatabaseSync(`${env.SQUARE_CODEX_BOUNDARIES}.lock`);
  lock.exec('BEGIN EXCLUSIVE');
  let held = true;
  const release = () => {
    if (held) lock.exec('ROLLBACK');
    held = false;
  };
  const watchdog = setTimeout(release, 1000);
  try {
    const startedAt = Date.now();
    await assert.rejects(codexHookResponse(
      { session_id: 'thread', hook_event_name: 'Stop', cwd: root },
      () => { throw new Error('Stop must not look up the inbox'); },
      env,
      [],
      () => {},
    ), { name: 'AbortError' });
    assert.ok(Date.now() - startedAt < 300, 'Stop must settle near its 60ms budget');
    assert.equal(held, true);

    await assert.rejects(runCodexHookAsync(JSON.stringify({
      session_id: 'thread', hook_event_name: 'SessionEnd', cwd: root,
    }), env), { name: 'AbortError' });
    assert.equal(held, true);
    assert.deepEqual(await readCodexBoundary('thread', env), before);
  } finally {
    clearTimeout(watchdog);
    release();
    lock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
