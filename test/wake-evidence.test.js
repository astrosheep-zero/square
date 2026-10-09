import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeWakeEvidence } from '../dist/wake-evidence.js';

const record = {
  kind: 'wake',
  location: '/SQUARE.square',
  participant: 'Faye',
  session: 'test-session',
  activity: 'act/4',
  outcome: 'failed',
  routeKind: 'paseo',
  attemptN: 2,
  signature: 'not_idle',
  message: 'The agent is not idle.',
  diagnostic: { phase: 'selection' },
};
const attention = { squarePath: record.location, recipient: record.participant, actIndex: 4 };
const metadata = { session: record.session, signature: record.signature, message: record.message, diagnostic: record.diagnostic };

test('wake attempts validate outcomes and retain attention and diagnostic metadata', () => {
  for (const outcome of ['accepted', 'unknown', 'failed']) {
    assert.deepEqual(decodeWakeEvidence({ ...record, outcome }, 100), {
      kind: 'attempt',
      value: { at: 100, attention, ...metadata, routeKind: 'paseo', attemptN: 2, outcome },
    });
  }
  assert.equal(decodeWakeEvidence({ ...record, at: 0 }, 100).value.at, 0);
  for (const overrides of [
    { outcome: 'not-capable' },
    { outcome: 'dispatching' },
    { outcome: 'presented' },
    { outcome: '' },
    { routeKind: undefined },
    { attemptN: undefined },
    { attemptN: '2' },
    { activity: 'invalid' },
    { kind: 'presentation' },
    { kind: 'lifecycle' },
  ]) {
    assert.equal(decodeWakeEvidence({ ...record, ...overrides }, 100), undefined);
  }
});

test('wake releases stay separate from attempts and require time but not route metadata', () => {
  const release = { ...record, outcome: 'released', at: 50 };
  assert.deepEqual(decodeWakeEvidence(release, 100), {
    kind: 'release',
    value: { at: 50, attention, ...metadata, routeKind: 'paseo', attemptN: 2 },
  });
  assert.deepEqual(decodeWakeEvidence({ ...release, routeKind: undefined, attemptN: undefined }, 100), {
    kind: 'release',
    value: { at: 50, attention, ...metadata },
  });
  assert.equal(decodeWakeEvidence({ ...release, at: undefined }, 100), undefined);
  assert.equal(decodeWakeEvidence({ ...release, activity: 'invalid' }, 100), undefined);
});
