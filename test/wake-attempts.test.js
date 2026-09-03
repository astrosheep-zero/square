import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatActivityId } from '../dist/square-core.js';
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
    env: { SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'), SQUARE_HOST_LEDGER_USER: path.join(root, 'host-ledger') },
  };
}

function row(item, overrides = {}) {
  return {
    v: 1,
    at: 1_000,
    location: item.attention.squarePath,
    participant: 'Faye',
    session: 'test-session',
    activity: formatActivityId(4),
    kind: 'wake',
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'test',
    attemptN: 1,
    ...overrides,
  };
}

test('wake attempt reads accept only real adapter outcomes inside retention', async () => {
  const item = fixture();
  const now = 8 * DAY_MS;
  fs.mkdirSync(item.env.SQUARE_HOST_LEDGER_USER, { recursive: true });
  fs.writeFileSync(path.join(item.env.SQUARE_HOST_LEDGER_USER, 'evidence.ndjsonl'), [
    '{bad json',
    JSON.stringify(row(item, { at: now - 7 * DAY_MS - 1 })),
    JSON.stringify(row(item, { at: now + 1 })),
    JSON.stringify(row(item, { at: now - DAY_MS, routeKind: undefined })),
    JSON.stringify(row(item, { at: now - DAY_MS, outcome: 'unknown', signature: undefined })),
    JSON.stringify(row(item, { at: now - 7 * DAY_MS, outcome: 'accepted', signature: undefined, attemptN: 2 })),
  ].join('\n'));

  assert.deepEqual((await readWakeAttempts({ env: item.env, now })).map((attempt) => [attempt.outcome, attempt.attemptN]), [
    ['unknown', 1], ['accepted', 2],
  ]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('wake attempt persistence redacts transport credentials recursively', async () => {
  const item = fixture();
  const env = { ...item.env, PASEO_PASSWORD: 'very-secret' };
  await recordWakeAttempt({
    attention: item.attention,
    routeKind: 'paseo',
    outcome: 'unknown',
    signature: 'send_unknown',
    attemptN: 1,
    message: 'failed with very-secret and ?password=query-secret',
    diagnostic: { nested: ['very-secret', 'tcp://host?password=another-secret&x=1'] },
  }, env);

  const raw = fs.readFileSync(path.join(item.env.SQUARE_HOST_LEDGER_USER, 'evidence.ndjsonl'), 'utf8');
  assert.doesNotMatch(raw, /very-secret|query-secret|another-secret/);
  assert.match(raw, /\[redacted\]/);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a wake attempt write drops expired and malformed ledger rows', async () => {
  const item = fixture();
  const now = 8 * DAY_MS;
  fs.mkdirSync(item.env.SQUARE_HOST_LEDGER_USER, { recursive: true });
  fs.writeFileSync(path.join(item.env.SQUARE_HOST_LEDGER_USER, 'evidence.ndjsonl'), [
    '{bad json',
    JSON.stringify(row(item, { at: now - 7 * DAY_MS - 1 })),
    JSON.stringify(row(item, { at: now - DAY_MS, attemptN: 2 })),
  ].join('\n'));

  await recordWakeAttempt({
    at: now,
    attention: item.attention,
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'new_route_failure',
    attemptN: 3,
  }, item.env);

  const rows = fs.readFileSync(path.join(item.env.SQUARE_HOST_LEDGER_USER, 'evidence.ndjsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((entry) => entry.attemptN), [2, 3]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('failed routes remain retryable while unknown stops the same route', () => {
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

  assert.equal(isWakeRouteAttemptable(sameFact, [failed]), true);
  assert.equal(isWakeRouteAttemptable(newFact, [failed]), true);
  assert.equal(hasAttemptableWakeRoute([sameFact], [failed]), true);

  const unknown = {
    at: 102,
    attention,
    routeKind: 'paseo',
    outcome: 'unknown',
    signature: 'send_unknown',
    attemptN: 2,
  };
  assert.equal(terminalWakeEvidence([failed, unknown]), undefined);
  assert.equal(isWakeRouteAttemptable({ kind: 'paseo', updatedAt: 200 }, [failed, unknown]), false);
});
