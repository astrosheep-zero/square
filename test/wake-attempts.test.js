import assert from 'node:assert/strict';
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

test('route retry requires new route evidence, and unknown stops every route', () => {
  const attention = { squarePath: '/square.md', actIndex: 4, recipient: 'Faye' };
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
