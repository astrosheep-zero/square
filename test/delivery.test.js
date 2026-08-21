import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyRuntimeState } from '../dist/artifact.js';
import { deriveDeliveryModel, leaseOwnsNotification, markDeliveredNotifications } from '../dist/delivery.js';
import { formatActivityId } from '../dist/square-core.js';

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
  runtime.cursors.Bob = { consumedThroughIndex: 4, updatedAt: 5 };
  const square = squareState(acts, runtime);
  const delivery = deriveDeliveryModel(square);

  assert.deepEqual(delivery.pendingFor('bob').map(({ item }) => item.index), [3]);
  assert.equal(markDeliveredNotifications(square, 'Bob', [square.acts[3]], 6), true);
  assert.deepEqual(deriveDeliveryModel(square).pendingFor('Bob'), []);
  assert.equal(square.runtime.deliveryReceipts.Bob[formatActivityId(3)].status, 'delivered');
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

test('a catch lease owns only the notifications admitted by its filter', () => {
  const mention = { actor: 'Alice', body: 'question @Bob', route: 'mention' };
  const bell = { actor: 'Alice', body: 'attention', route: 'bell' };
  const lease = { leaseId: 'a', heartbeatAt: 1, expiresAt: 2 };

  assert.equal(leaseOwnsNotification(lease, mention), true);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'] } }, mention), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Cara' } }, mention), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'], mention: 'Cara' } }, bell), true);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Bob' } }, mention), true);
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
