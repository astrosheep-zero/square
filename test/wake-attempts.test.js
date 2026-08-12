import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deriveWakeObligation,
  hasAttemptableWakeRoute,
  isWakeRouteAttemptable,
  MAX_WAKE_OBLIGATIONS,
  readWakeAttempts,
  recordWakeAttempt,
  WAKE_ACK_ESCALATION_MS,
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
    obligation_n: 1,
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
    JSON.stringify(row(item, { ts: now - DAY_MS, obligation_n: undefined })),
    JSON.stringify(row(item, { ts: now - DAY_MS, outcome: 'unknown', signature: undefined })),
    JSON.stringify(row(item, { ts: now - 7 * DAY_MS, outcome: 'accepted', signature: undefined, attempt_n: 2 })),
  ].join('\n'));

  assert.deepEqual(readWakeAttempts({ env: item.env, now }).map((attempt) => [attempt.outcome, attempt.attemptN, attempt.obligationN]), [
    ['accepted', 2, 1],
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
    obligationN: 1,
    message: 'failed with very-secret and ?password=query-secret',
    diagnostic: { nested: ['very-secret', 'tcp://host?password=another-secret&x=1'] },
  }, env);

  const raw = fs.readFileSync(item.env.SQUARE_WAKE_ATTEMPTS, 'utf8');
  assert.doesNotMatch(raw, /very-secret|query-secret|another-secret/);
  assert.match(raw, /\[redacted\]/);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('route retry requires new evidence within the current obligation, and unknown stops every obligation', () => {
  const attention = { squarePath: '/square.md', actIndex: 4, recipient: 'Faye' };
  const failed = {
    at: 100,
    attention,
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'address_not_found',
    attemptN: 1,
    obligationN: 1,
  };
  const sameFact = { kind: 'paseo', updatedAt: 100 };
  const newFact = { kind: 'paseo', updatedAt: 101 };

  assert.equal(isWakeRouteAttemptable(sameFact, [failed], 1), false);
  assert.equal(isWakeRouteAttemptable(newFact, [failed], 1), true);
  assert.equal(hasAttemptableWakeRoute([sameFact], [failed], 1), false);
  assert.equal(isWakeRouteAttemptable(sameFact, [failed], 2), true);

  const unknown = {
    at: 102,
    attention,
    routeKind: 'paseo',
    outcome: 'unknown',
    signature: 'send_unknown',
    attemptN: 2,
    obligationN: 2,
  };
  assert.equal(isWakeRouteAttemptable({ kind: 'paseo', updatedAt: 200 }, [failed, unknown], 3), false);
});

test('requires-ack opens at most three informedness obligations and failed attempts spend no budget', () => {
  const attention = { squarePath: '/square.md', actIndex: 4, recipient: 'Faye' };
  const attempt = (outcome, obligationN, at, attemptN = obligationN) => ({
    at,
    attention,
    routeKind: 'paseo',
    outcome,
    ...(outcome === 'accepted' ? {} : { signature: 'test' }),
    attemptN,
    obligationN,
  });
  const accepted1 = attempt('accepted', 1, 100);
  const failed2 = attempt('failed', 2, 200, 2);
  const accepted2 = attempt('accepted', 2, 300, 3);
  const accepted3 = attempt('accepted', 3, 400, 4);

  assert.deepEqual(deriveWakeObligation(true, [], 1), { type: 'open', obligationN: 1 });
  assert.equal(deriveWakeObligation(true, [accepted1], 100 + WAKE_ACK_ESCALATION_MS).type, 'waiting');
  assert.deepEqual(
    deriveWakeObligation(true, [accepted1, failed2], 100 + WAKE_ACK_ESCALATION_MS + 1),
    { type: 'open', obligationN: 2 },
  );
  assert.deepEqual(
    deriveWakeObligation(true, [accepted1, failed2, accepted2], 300 + WAKE_ACK_ESCALATION_MS + 1),
    { type: 'open', obligationN: 3 },
  );
  const exhausted = deriveWakeObligation(
    true,
    [accepted1, failed2, accepted2, accepted3],
    400 + WAKE_ACK_ESCALATION_MS + 1,
  );
  assert.equal(exhausted.type, 'exhausted');
  assert.equal(new Set([accepted1, accepted2, accepted3].map((item) => item.obligationN)).size, MAX_WAKE_OBLIGATIONS);
});

test('presented is informedness without spending wake budget and unknown is a global stop', () => {
  const presentedAt = 100;
  assert.equal(deriveWakeObligation(true, [], presentedAt + WAKE_ACK_ESCALATION_MS, presentedAt).type, 'waiting');
  assert.equal(deriveWakeObligation(true, [], presentedAt + WAKE_ACK_ESCALATION_MS + 1, presentedAt).type, 'exhausted');

  const unknown = {
    at: 200,
    attention: { squarePath: '/square.md', actIndex: 4, recipient: 'Faye' },
    routeKind: 'paseo',
    outcome: 'unknown',
    signature: 'send_unknown',
    attemptN: 1,
    obligationN: 1,
  };
  assert.deepEqual(deriveWakeObligation(true, [unknown], 300), {
    type: 'stopped', reason: 'unknown', attempt: unknown,
  });
});
