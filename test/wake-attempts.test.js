import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  hasAttemptableWakeRoute,
  isWakeRouteAttemptable,
  readWakeAttempts,
  recordWakeAttempt,
  terminalWakeEvidence,
} from '../dist/wake-attempts.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-attempts-'));
  return {
    root,
    attention: { squarePath: path.join(root, 'SQUARE.square'), actIndex: 4, recipient: 'Faye' },
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

test('wake attempt reads accept only real adapter outcomes inside retention', () => {
  const item = fixture();
  const now = 8 * DAY_MS;
  fs.writeFileSync(item.env.SQUARE_WAKE_ATTEMPTS, [
    '{bad json',
    JSON.stringify(row(item, { ts: now - 7 * DAY_MS - 1 })),
    JSON.stringify(row(item, { ts: now + 1 })),
    JSON.stringify(row(item, { ts: now - DAY_MS, route_kind: undefined })),
    JSON.stringify(row(item, { ts: now - DAY_MS, outcome: 'unknown', signature: undefined })),
    JSON.stringify(row(item, { ts: now - 7 * DAY_MS, outcome: 'accepted', signature: undefined, attempt_n: 2 })),
  ].join('\n'));

  assert.deepEqual(readWakeAttempts({ env: item.env, now }).map((attempt) => [attempt.outcome, attempt.attemptN]), [
    ['accepted', 2],
  ]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('wake attempt persistence redacts transport credentials recursively', () => {
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

test('a wake attempt write drops expired and malformed ledger rows', () => {
  const item = fixture();
  const now = 8 * DAY_MS;
  fs.writeFileSync(item.env.SQUARE_WAKE_ATTEMPTS, [
    '{bad json',
    JSON.stringify(row(item, { ts: now - 7 * DAY_MS - 1 })),
    JSON.stringify(row(item, { ts: now - DAY_MS, attempt_n: 2 })),
  ].join('\n'));

  recordWakeAttempt({
    at: now,
    attention: item.attention,
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'new_route_failure',
    attemptN: 3,
  }, item.env);

  const rows = fs.readFileSync(item.env.SQUARE_WAKE_ATTEMPTS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((entry) => entry.attempt_n), [2, 3]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a wake attempt write immediately recovers a lock abandoned by a dead process', () => {
  const item = fixture();
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(exited.status, 0, exited.stderr);
  fs.writeFileSync(`${item.env.SQUARE_WAKE_ATTEMPTS}.lock`, `${exited.pid}\n${Date.now()}\n`);

  const moduleUrl = new URL('../dist/wake-attempts.js', import.meta.url).href;
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { recordWakeAttempt } from ${JSON.stringify(moduleUrl)};
    recordWakeAttempt({
      attention: { squarePath: process.env.TEST_SQUARE_PATH, actIndex: 4, recipient: 'Faye' },
      routeKind: 'paseo',
      outcome: 'accepted',
      attemptN: 1,
    });
  `], {
    encoding: 'utf8',
    env: { ...process.env, ...item.env, TEST_SQUARE_PATH: item.attention.squarePath },
    timeout: 2_000,
  });

  assert.equal(writer.status, 0, writer.stderr);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map((attempt) => attempt.outcome), ['accepted']);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('route retry requires new route evidence, and unknown stops every route', () => {
  const attention = { squarePath: '/SQUARE.square', actIndex: 4, recipient: 'Faye' };
  const failed = {
    at: 100,
    attention,
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'address_not_found',
    attemptN: 1,
  };
  const sameFact = { kind: 'paseo', updatedAt: 100 };
  const newFact = { kind: 'paseo', updatedAt: 101 };

  assert.equal(isWakeRouteAttemptable(sameFact, [failed]), false);
  assert.equal(isWakeRouteAttemptable(newFact, [failed]), true);
  assert.equal(hasAttemptableWakeRoute([sameFact], [failed]), false);

  const unknown = {
    at: 102,
    attention,
    routeKind: 'paseo',
    outcome: 'unknown',
    signature: 'send_unknown',
    attemptN: 2,
  };
  assert.equal(terminalWakeEvidence([failed, unknown]), unknown);
  assert.equal(isWakeRouteAttemptable({ kind: 'paseo', updatedAt: 200 }, [failed, unknown]), false);
});
