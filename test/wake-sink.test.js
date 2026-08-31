import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PaseoWakeSendError, sendPaseoWake } from '../dist/wake-sink.js';
import { nodeCommandFixture } from './node-command-fixture.js';

function fakePaseo(body) {
  return nodeCommandFixture('square-wake-sink', body);
}

function captureKind(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PaseoWakeSendError);
    return error.kind;
  }
  assert.fail('Expected Paseo wake to fail.');
}

test('Paseo connection refusal is a transient pre-accept failure', () => {
  const fake = fakePaseo(`console.error('{"error":{"code":"DAEMON_NOT_RUNNING","message":"connect ECONNREFUSED"}}'); process.exit(1);`);
  try {
    assert.equal(captureKind(() => sendPaseoWake({ agentId: 'a', prompt: 'wake' }, fake)), 'transient');
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('Paseo wake success forwards the agent and awareness prompt', () => {
  const fake = fakePaseo(`require('node:fs').writeFileSync(process.env.SQUARE_WAKE_ARGS, process.argv.slice(2).join('\\n')); process.exit(0);`);
  const previousArgs = process.env.SQUARE_WAKE_ARGS;
  const argsFile = path.join(fake.root, 'args');
  process.env.SQUARE_WAKE_ARGS = argsFile;
  try {
    sendPaseoWake({ agentId: 'agent-1', prompt: '<system-reminder>attention</system-reminder>' }, fake);
    assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), [
      'send',
      'agent-1',
      '--prompt',
      '<system-reminder>attention</system-reminder>',
      '--no-wait',
      '--json',
    ]);
  } finally {
    if (previousArgs === undefined) delete process.env.SQUARE_WAKE_ARGS;
    else process.env.SQUARE_WAKE_ARGS = previousArgs;
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('Paseo authentication rejection is a proven pre-accept rejection', () => {
  const fake = fakePaseo(`console.error('{"error":{"code":"SEND_FAILED","message":"Incorrect password"}}'); process.exit(1);`);
  try {
    assert.equal(captureKind(() => sendPaseoWake({ agentId: 'a', prompt: 'wake' }, fake)), 'rejected');
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('Paseo command timeout is unknown and must not be retried', () => {
  const fake = fakePaseo('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);');
  try {
    assert.equal(captureKind(() => sendPaseoWake({ agentId: 'a', prompt: 'wake' }, { ...fake, timeoutMs: 10 })), 'unknown');
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('Paseo URI passwords are redacted from surfaced command failures', () => {
  const fake = fakePaseo(`console.error('{"error":{"code":"DAEMON_NOT_RUNNING","message":"Cannot connect to tcp://host:6767?password=top-secret"}}'); process.exit(1);`);
  try {
    assert.throws(
      () => sendPaseoWake({ agentId: 'a', prompt: 'wake' }, fake),
      (error) => error instanceof PaseoWakeSendError && !error.message.includes('top-secret') && error.message.includes('[redacted]')
    );
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});
