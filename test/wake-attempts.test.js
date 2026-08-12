import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readWakeAttempts,
  recordRecoveredUnknown,
  recordWakeAttempt,
  terminalWakeAttempt,
} from '../dist/wake-attempts.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-attempts-'));
  return {
    root,
    attention: { squarePath: path.join(root, 'square.md'), actIndex: 4, recipient: 'Faye' },
    env: { SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl') },
  };
}

function row(item, overrides = {}) {
  return {
    v: 1,
    ts: 1_000,
    attention: {
      square_path: item.attention.squarePath,
      act_id: 'act_4',
      recipient: 'Faye',
    },
    route_kind: 'paseo',
    outcome: 'failed',
    signature: 'test',
    attempt_n: 1,
    ...overrides,
  };
}

test('wake attempt reads ignore malformed, future, and expired rows', () => {
  const item = fixture();
  const now = 8 * DAY_MS;
  fs.writeFileSync(item.env.SQUARE_WAKE_ATTEMPTS, [
    '{bad json',
    JSON.stringify(row(item, { ts: now - 7 * DAY_MS - 1 })),
    JSON.stringify(row(item, { ts: now + 1 })),
    JSON.stringify(row(item, { ts: now - DAY_MS, attempt_n: 0 })),
    JSON.stringify(row(item, { ts: now - 7 * DAY_MS, outcome: 'accepted', attempt_n: 2 })),
  ].join('\n'));

  assert.deepEqual(readWakeAttempts({ env: item.env, now }).map((attempt) => [attempt.outcome, attempt.attemptN]), [
    ['accepted', 2],
  ]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('wake attempt persistence redacts Paseo secrets recursively', () => {
  const item = fixture();
  const env = { ...item.env, PASEO_PASSWORD: 'very-secret' };
  recordWakeAttempt({
    attention: item.attention,
    routeKind: 'paseo',
    outcome: 'unknown',
    signature: 'send_unknown',
    attemptN: 1,
    message: 'failed with very-secret and ?password=query-secret',
    diagnostic: { nested: ['very-secret', 'tcp://host?password=another-secret&x=1'] },
  }, env);

  const raw = fs.readFileSync(item.env.SQUARE_WAKE_ATTEMPTS, 'utf8');
  assert.doesNotMatch(raw, /very-secret|query-secret|another-secret/);
  assert.match(raw, /\[redacted\]/);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('interrupted dispatch recovery is idempotent', () => {
  const item = fixture();
  const lease = { attemptN: 3, routeKind: 'paseo' };
  const first = recordRecoveredUnknown(item.attention, lease, item.env, 1_000);
  const second = recordRecoveredUnknown(item.attention, lease, item.env, 1_001);

  assert.equal(first?.outcome, 'unknown');
  assert.equal(second?.attemptN, 3);
  assert.deepEqual(readWakeAttempts({ env: item.env, now: 1_001 }).map((attempt) => attempt.signature), [
    'worker_interrupted_during_dispatch',
  ]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a pre-accept failure does not close interrupted dispatch recovery', () => {
  const item = fixture();
  recordWakeAttempt({
    attention: item.attention,
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'send_pre_accept_transient',
    attemptN: 3,
    at: 999,
  }, item.env);
  recordRecoveredUnknown(item.attention, { attemptN: 3, routeKind: 'paseo' }, item.env, 1_000);

  assert.deepEqual(readWakeAttempts({ env: item.env, now: 1_000 }).map((attempt) => attempt.outcome), [
    'failed',
    'unknown',
  ]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a later diagnostic failure cannot reopen terminal attention', () => {
  const item = fixture();
  recordWakeAttempt({
    attention: item.attention,
    routeKind: 'paseo',
    outcome: 'unknown',
    signature: 'send_unknown',
    attemptN: 1,
    at: 1_000,
  }, item.env);
  recordWakeAttempt({
    attention: item.attention,
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'late_failure',
    attemptN: 1,
    at: 1_001,
  }, item.env);

  assert.equal(terminalWakeAttempt(item.attention, { env: item.env, now: 1_001 })?.outcome, 'unknown');
  fs.rmSync(item.root, { recursive: true, force: true });
});
