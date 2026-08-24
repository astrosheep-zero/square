import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyRuntimeState } from '../dist/artifact.js';
import { deriveDeliveryModel, leaseOwnsNotification, markSeenNotifications, perceiveActivity } from '../dist/delivery.js';
import { renderAttentionPreview } from '../dist/attention-presentation.js';
import { formatActivityId } from '../dist/square-core.js';
import { readCursor, recordObservation } from '../dist/runtime.js';

function squareState(acts, runtime = emptyRuntimeState(acts.length)) {
  return {
    hardCap: null,
    preamble: [],
    warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { ...runtime, nextActIndex: acts.length },
  };
}

function plannedRecipients(model, act) {
  return model.plan(act).map(({ recipient, route }) => `${recipient}:${route}`);
}

test('every reach mode addresses exactly its eligible peers', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
    { kind: 'join', actor: 'Cara', at: 3, body: '' },
    { kind: 'say', actor: 'Alice', at: 4, body: 'hello everyone' },
    { kind: 'say', actor: 'Alice', at: 5, body: 'hello @bob @BOB @Missing' },
    { kind: 'say', actor: 'Alice', at: 6, body: 'private @cara' },
    { kind: 'say', actor: 'Alice', at: 7, body: 'attention @Bob', reach: 'bell' },
    { kind: 'say', actor: 'Alice', at: 8, body: 'only @Alice' },
  ]);
  const delivery = deriveDeliveryModel(square);

  assert.deepEqual(plannedRecipients(delivery, square.acts[3]), []);
  assert.deepEqual(plannedRecipients(delivery, square.acts[4]), ['Bob:mention']);
  assert.deepEqual(plannedRecipients(delivery, square.acts[5]), ['Cara:mention']);
  assert.deepEqual(plannedRecipients(delivery, square.acts[6]), ['Bob:bell', 'Cara:bell']);
  assert.deepEqual(plannedRecipients(delivery, square.acts[7]), []);
});

test('pending attention is post-join, independent of the read cursor, and closes only with a receipt', () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'say', actor: 'Alice', at: 2, body: 'historical @Bob' },
    { kind: 'join', actor: 'Bob', at: 3, body: '' },
    { kind: 'say', actor: 'Alice', at: 4, body: 'pending @Bob' },
    { kind: 'say', actor: 'Bob', at: 5, body: 'self cursor advance' },
  ];
  const runtime = emptyRuntimeState(acts.length);
  runtime.observations.Bob = { 'act/4': { state: 'seen', at: 5 } };
  const square = squareState(acts, runtime);
  const delivery = deriveDeliveryModel(square);

  assert.deepEqual(delivery.pendingFor('bob').map(({ item }) => item.index), [3]);
  assert.equal(markSeenNotifications(square, 'Bob', [square.acts[3]], 6), true);
  assert.deepEqual(deriveDeliveryModel(square).pendingFor('Bob'), []);
  assert.equal(square.runtime.observations.Bob[formatActivityId(3)].state, 'seen');
});

test('a participant who has stepped out is not a delivery target', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
    { kind: 'done', actor: 'Bob', at: 3, body: '' },
    { kind: 'say', actor: 'Alice', at: 4, body: 'hey @Bob' },
  ]);
  const delivery = deriveDeliveryModel(square);

  assert.deepEqual(plannedRecipients(delivery, square.acts[3]), []);
  assert.deepEqual(delivery.pendingFor('Bob'), []);
});

test('listener audience is historical across ignore, done, and rejoin', () => {
  const square = squareState([
    { kind: 'join', actor: 'Caller', at: 1 },
    { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 2 },
    { kind: 'join', actor: 'aku/riko', at: 3 },
    { kind: 'say', actor: 'aku/riko', at: 4, body: 'first answer' },
    { kind: 'ignore', actor: 'Caller', target: 'aku/riko', at: 5 },
    { kind: 'say', actor: 'aku/riko', at: 6, body: 'ignored answer' },
    { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 7 },
    { kind: 'say', actor: 'aku/riko', at: 8, body: 'second answer' },
    { kind: 'done', actor: 'Caller', at: 9 },
    { kind: 'say', actor: 'aku/riko', at: 10, body: 'after done' },
    { kind: 'join', actor: 'Caller', at: 11 },
    { kind: 'say', actor: 'aku/riko', at: 12, body: 'after rejoin' },
  ]);
  const delivery = deriveDeliveryModel(square);

  assert.deepEqual(plannedRecipients(delivery, square.acts[3]), ['Caller:attention']);
  assert.deepEqual(plannedRecipients(delivery, square.acts[5]), []);
  assert.deepEqual(plannedRecipients(delivery, square.acts[7]), ['Caller:attention']);
  assert.deepEqual(plannedRecipients(delivery, square.acts[9]), []);
  assert.deepEqual(plannedRecipients(delivery, square.acts[11]), []);
  assert.equal(perceiveActivity(square, square.acts[3], 'Caller'), 'full');
  assert.equal(perceiveActivity(square, square.acts[3], 'Observer'), 'presence');
});

test('listener delivery attention does not claim a listener was mentioned', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'listen', actor: 'Bob', target: 'Alice', at: 3 },
    { kind: 'say', actor: 'Alice', body: 'bare thought', at: 4 },
  ]);
  const [{ route }] = deriveDeliveryModel(square).plan(square.acts[3]);
  assert.equal(route, 'attention');
  const rendered = renderAttentionPreview({ squarePath: '/tmp/listener.square', actIndex: 3, recipient: 'Bob', actor: 'Alice', route, body: 'bare thought' });
  assert.match(rendered, /\(attention\)/);
  assert.doesNotMatch(rendered, /\(mention\)/);
});

test('a later listen does not retroactively receive an earlier bare say', () => {
  const square = squareState([
    { kind: 'join', actor: 'Caller', at: 1 },
    { kind: 'join', actor: 'aku/riko', at: 2 },
    { kind: 'say', actor: 'aku/riko', at: 3, body: 'too early' },
    { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 4 },
  ]);
  assert.deepEqual(deriveDeliveryModel(square).plan(square.acts[2]), []);
  assert.equal(perceiveActivity(square, square.acts[2], 'Caller'), 'presence');
});

test('a catch lease owns only the notifications admitted by its filter', () => {
  const mention = { actor: 'Alice', body: 'question @Bob', route: 'mention' };
  const bell = { actor: 'Alice', body: 'attention', route: 'bell' };
  const lease = { leaseId: 'a', heartbeatAt: 1, expiresAt: 2 };

  assert.equal(leaseOwnsNotification(lease, mention), true);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'] } }, mention), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Cara' } }, mention), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'], mention: 'Cara' } }, bell), true);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Bob' } }, mention), true);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Bob' } }, { actor: 'aku/riko', body: 'bare answer', route: 'attention', recipient: 'Bob' }), true);
});

test('delivery route distinguishes mentioned recipients from listeners on the same say', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'listen', actor: 'Cara', target: 'Alice', at: 4 },
    { kind: 'say', actor: 'Alice', body: 'question @Bob', at: 5 },
  ]);
  assert.deepEqual(
    deriveDeliveryModel(square).plan(square.acts[4]).map(({ recipient, route }) => [recipient, route]),
    [['Bob', 'mention'], ['Cara', 'attention']],
  );
});

test('pending projection remains complete across a long history', () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
  ];
  for (let index = 0; index < 4_000; index++) {
    acts.push({
      kind: 'say',
      actor: 'Alice',
      at: index + 3,
      body: index % 1_000 === 0 ? `direct ${index} @Bob` : `undirected ${index}`,
    });
  }

  assert.deepEqual(
    deriveDeliveryModel(squareState(acts)).pendingFor('Bob').map(({ item }) => item.index),
    [2, 1_002, 2_002, 3_002]
  );
});

test('out-of-order observations advance only the continuous seen prefix', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'one' },
    { kind: 'say', actor: 'Alice', at: 4, body: 'two' },
    { kind: 'say', actor: 'Alice', at: 5, body: 'three' },
  ]);
  recordObservation(square, 'Bob', 3, 'seen', 8);
  recordObservation(square, 'Bob', 4, 'seen', 9);
  assert.equal(readCursor(square, 'Bob'), 1);
  recordObservation(square, 'Bob', 2, 'seen', 10);
  assert.equal(readCursor(square, 'Bob'), 4);
});
