import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForPaseoToolBoundary } from '../dist/paseo-timeline.js';

function snapshot(agentStatus, toolCalls = []) {
  return { agentStatus, toolCalls };
}

function sequenceReader(sequence) {
  let index = 0;
  return async () => sequence[Math.min(index++, sequence.length - 1)];
}

test('a wake is ready immediately when no active Paseo tool can be interrupted', async () => {
  for (const state of [snapshot('idle'), snapshot('running')]) {
    assert.equal(
      await waitForPaseoToolBoundary('agent-1', {
        readSnapshot: async () => state,
        delay: async () => { throw new Error('a ready agent must not wait'); },
      }),
      true
    );
  }
});

test('a wake waits only for the tool active when delivery began', async () => {
  const ready = await waitForPaseoToolBoundary('agent-1', {
    readSnapshot: sequenceReader([
      snapshot('running', [{ callId: 'current', status: 'running' }]),
      snapshot('running', [
        { callId: 'current', status: 'running' },
        { callId: 'next', status: 'running' },
      ]),
      snapshot('running', [
        { callId: 'current', status: 'completed' },
        { callId: 'next', status: 'running' },
      ]),
    ]),
    delay: async () => {},
  });

  assert.equal(ready, true);
});

test('terminal failure, timeout, and unavailable state never send into an unsafe boundary', async () => {
  const failedTool = await waitForPaseoToolBoundary('agent-1', {
    readSnapshot: sequenceReader([
      snapshot('running', [{ callId: 'current', status: 'running' }]),
      snapshot('running', [{ callId: 'current', status: 'failed' }]),
    ]),
    delay: async () => {},
  });
  assert.equal(failedTool, true);

  const timedOut = await waitForPaseoToolBoundary('agent-1', {
    readSnapshot: async () => snapshot('running', [{ callId: 'current', status: 'running' }]),
    pollIntervalMs: 2,
    timeoutMs: 1,
  });
  assert.equal(timedOut, false);

  assert.equal(
    await waitForPaseoToolBoundary('agent-1', { readSnapshot: async () => snapshot('error') }),
    false
  );
  assert.equal(
    await waitForPaseoToolBoundary('agent-1', { readSnapshot: async () => { throw new Error('daemon unavailable'); } }),
    false
  );
});
