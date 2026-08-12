import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PaseoWakeSendError, sendPaseoWake } from '../dist/wake-sink.js';

function fakePaseo(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-sink-'));
  const file = path.join(dir, 'paseo');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return { dir, file };
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

test('Paseo connection refusal is retryable before daemon acceptance', () => {
  const fake = fakePaseo(`printf '%s\\n' '{"error":{"code":"DAEMON_NOT_RUNNING","message":"connect ECONNREFUSED"}}' >&2\nexit 1`);
  const previous = process.env.SQUARE_PASEO_BIN;
  process.env.SQUARE_PASEO_BIN = fake.file;
  try {
    assert.equal(captureKind(() => sendPaseoWake({ agentId: 'a', prompt: 'wake' })), 'retryable');
  } finally {
    if (previous === undefined) delete process.env.SQUARE_PASEO_BIN;
    else process.env.SQUARE_PASEO_BIN = previous;
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('Paseo authentication rejection is permanent', () => {
  const fake = fakePaseo(`printf '%s\\n' '{"error":{"code":"SEND_FAILED","message":"Incorrect password"}}' >&2\nexit 1`);
  const previous = process.env.SQUARE_PASEO_BIN;
  process.env.SQUARE_PASEO_BIN = fake.file;
  try {
    assert.equal(captureKind(() => sendPaseoWake({ agentId: 'a', prompt: 'wake' })), 'permanent');
  } finally {
    if (previous === undefined) delete process.env.SQUARE_PASEO_BIN;
    else process.env.SQUARE_PASEO_BIN = previous;
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('Paseo command timeout is unknown and must not be retried', () => {
  const fake = fakePaseo('sleep 1');
  const previous = process.env.SQUARE_PASEO_BIN;
  process.env.SQUARE_PASEO_BIN = fake.file;
  try {
    assert.equal(captureKind(() => sendPaseoWake({ agentId: 'a', prompt: 'wake' }, { timeoutMs: 10 })), 'unknown');
  } finally {
    if (previous === undefined) delete process.env.SQUARE_PASEO_BIN;
    else process.env.SQUARE_PASEO_BIN = previous;
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('Paseo URI passwords are redacted from surfaced command failures', () => {
  const fake = fakePaseo(`printf '%s\\n' '{"error":{"code":"DAEMON_NOT_RUNNING","message":"Cannot connect to tcp://host:6767?password=top-secret"}}' >&2\nexit 1`);
  const previous = process.env.SQUARE_PASEO_BIN;
  process.env.SQUARE_PASEO_BIN = fake.file;
  try {
    assert.throws(
      () => sendPaseoWake({ agentId: 'a', prompt: 'wake' }),
      (error) => error instanceof PaseoWakeSendError && !error.message.includes('top-secret') && error.message.includes('[redacted]')
    );
  } finally {
    if (previous === undefined) delete process.env.SQUARE_PASEO_BIN;
    else process.env.SQUARE_PASEO_BIN = previous;
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});
