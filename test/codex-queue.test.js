import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCodexBoundary,
  codexQueueEligible,
  readCodexBoundary,
  recordCodexBoundary,
} from '../dist/codex-boundary-state.js';
import {
  CodexQueueAdapter,
  CodexQueueSendError,
  sendCodexQueue,
} from '../dist/codex-queue.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-queue-'));
  return { root, env: { SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json') } };
}

test('Codex boundary state allows queue only after the latest Stop', async () => {
  const item = fixture();
  try {
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    await recordCodexBoundary('thread-a', 'non-stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    assert.deepEqual(await readCodexBoundary('thread-a', item.env), { lastStop: 3, lastNonStop: 2 });
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex boundary state is isolated per thread and SessionEnd clears it', async () => {
  const item = fixture();
  try {
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    await recordCodexBoundary('thread-b', 'non-stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    assert.equal(await codexQueueEligible('thread-b', item.env), false);
    await clearCodexBoundary('thread-a', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    assert.equal(await readCodexBoundary('thread-a', item.env), undefined);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex queue adapter retains an ineligible route without sending', async () => {
  const item = fixture();
  let sent = false;
  try {
    const result = await new CodexQueueAdapter({
      env: item.env,
      sendQueue: () => { sent = true; },
    }).dispatch({ threadId: 'thread-a' }, 'awareness', async () => true);
    assert.deepEqual(result, {
      outcome: 'unavailable',
      signature: 'boundary_not_stopped',
      message: 'The Codex thread has not reached a current Stop boundary.',
      retainRoute: true,
    });
    assert.equal(sent, false);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex queue adapter sends only after the final boundary check', async () => {
  const item = fixture();
  const requests = [];
  try {
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    const result = await new CodexQueueAdapter({
      env: item.env,
      sendQueue: (request) => { requests.push(request); },
    }).dispatch({ threadId: 'thread-a' }, 'awareness', async () => true);
    assert.deepEqual(result, { outcome: 'accepted' });
    assert.deepEqual(requests, [{ threadId: 'thread-a', message: 'awareness' }]);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex queue transport uses the exact CLI shape and classifies failures', () => {
  const bin = path.join(os.tmpdir(), `square-codex-bin-${process.pid}-${Date.now()}`);
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SQUARE_CODEX_ARGS"\n');
  fs.chmodSync(bin, 0o755);
  try {
    const env = { SQUARE_CODEX_ARGS: `${bin}.args` };
    sendCodexQueue({ threadId: 'thread-a', message: 'hello' }, { bin, env });
    assert.deepEqual(fs.readFileSync(env.SQUARE_CODEX_ARGS, 'utf8').trim().split('\n'), [
      'queue', '--thread', 'thread-a', '--message', 'hello',
    ]);
    assert.throws(
      () => sendCodexQueue({ threadId: 'thread-a', message: 'hello' }, { bin: '/missing/codex' }),
      (error) => error instanceof CodexQueueSendError && error.kind === 'transient',
    );
  } finally {
    fs.rmSync(bin, { force: true });
    fs.rmSync(`${bin}.args`, { force: true });
  }
});
