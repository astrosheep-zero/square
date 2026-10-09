import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { emptyRuntimeState } from '../dist/artifact.js';
import { deriveDeliveryModel, leaseOwnsNotification, markSeenNotifications, perceiveActivity } from '../dist/delivery.js';
import { decideCatch } from '../dist/catch-decisions.js';
import { pendingAtBoundary } from '../dist/square-projections.js';
import { previewAttentionBody, renderAttentionPreview } from '../dist/attention-presentation.js';
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
    { kind: 'say', actor: 'Alice', at: 5, body: 'hello @bob @BOB @Missing', mentions: ['bob', 'BOB', 'Missing'] },
    { kind: 'say', actor: 'Alice', at: 6, body: 'private @cara', mentions: ['cara'] },
    { kind: 'say', actor: 'Alice', at: 7, body: 'attention @Bob', reach: 'bell' },
    { kind: 'say', actor: 'Alice', at: 8, body: 'only @Alice', mentions: ['Alice'] },
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
    { kind: 'say', actor: 'Alice', at: 2, body: 'historical @Bob', mentions: ['Bob'] },
    { kind: 'join', actor: 'Bob', at: 3, body: '' },
    { kind: 'say', actor: 'Alice', at: 4, body: 'pending @Bob', mentions: ['Bob'] },
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
    { kind: 'say', actor: 'Alice', at: 4, body: 'hey @Bob', mentions: ['Bob'] },
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

test('ignore blocks future mentions and bare delivery until listen clears it', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'ignore', actor: 'Bob', target: 'Alice', at: 3 },
    { kind: 'say', actor: 'Alice', body: 'blocked @Bob', mentions: ['Bob'], at: 4 },
    { kind: 'listen', actor: 'Bob', target: 'Alice', at: 5 },
    { kind: 'say', actor: 'Alice', body: 'bare after listen', at: 6 },
    { kind: 'say', actor: 'Alice', body: 'mention after listen @Bob', mentions: ['Bob'], at: 7 },
  ]);
  const delivery = deriveDeliveryModel(square);

  assert.deepEqual(plannedRecipients(delivery, square.acts[3]), []);
  assert.deepEqual(plannedRecipients(delivery, square.acts[5]), ['Bob:attention']);
  assert.deepEqual(plannedRecipients(delivery, square.acts[6]), ['Bob:mention']);
});

test('attention preview distinguishes being addressed, listening, and everyone’s attention', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'listen', actor: 'Bob', target: 'Alice', at: 3 },
    { kind: 'say', actor: 'Alice', body: 'bare thought', at: 4 },
    { kind: 'say', actor: 'Alice', body: 'direct thought', mentions: ['Bob'], at: 5 },
    { kind: 'say', actor: 'Alice', body: 'everyone listen', reach: 'bell', at: 6 },
  ]);
  const delivery = deriveDeliveryModel(square);
  const descriptions = square.acts.slice(3).map((act) => {
    const [{ route, recipient }] = delivery.plan(act);
    return renderAttentionPreview({ squarePath: '/tmp/listener.square', actIndex: act.index, recipient, actor: act.actor, route, body: act.body }).split('\n')[2];
  });
  assert.deepEqual(descriptions, [
    '● Alice spoke · you’re listening to Alice',
    '● Alice addressed you (Bob)',
    '● Alice rang the bell · everyone’s attention',
  ]);
});

test('attention metadata is separate from unindented Markdown body', () => {
  const body = '*thought*\n\n- item\n  - nested\n\n```js\n  run();\n```';
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a"&<b>.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body });
  assert.equal(rendered, [
    '````square-activity',
    '· /tmp/a"&<b>.square · act/12',
    '● Alice rang the bell · everyone’s attention',
    '',
    body,
    '````',
  ].join('\n'));
});

test('attention body is complete up to the preview boundary', () => {
  assert.equal(previewAttentionBody('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(previewAttentionBody('x'.repeat(201)), `${'x'.repeat(200)}…`);
});

test('clipped attention ends with a labeled caption and a bare read-it-all command', () => {
  const body = 'x'.repeat(250);
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body });
  assert.equal(rendered, [
    '```square-activity',
    '· /tmp/a.square · act/12',
    '● Alice rang the bell · everyone’s attention',
    '',
    `${'x'.repeat(200)}…`,
    '```',
    '· clipped — read it all:',
    `square --location '${path.resolve('/tmp/a.square')}' --as 'Bob' catch --id act/12`,
  ].join('\n'));
});

test('unclipped attention has no continuation command', () => {
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body: 'short' });
  assert.doesNotMatch(rendered, /catch --id/);
});

test('a backtick run in the command path stays outside the fence', () => {
  const body = 'x'.repeat(201);
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a```b.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body });
  const lines = rendered.split('\n');
  assert.equal(lines[0], '```square-activity');
  assert.equal(lines[5], '```');
  assert.equal(lines[6], '· clipped — read it all:');
  assert.equal(lines[7], `square --location '${path.resolve('/tmp/a```b.square')}' --as 'Bob' catch --id act/12`);
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
  const mention = { actor: 'Alice', body: 'question @Bob', route: 'mention', recipient: 'Bob' };
  const bell = { actor: 'Alice', body: 'attention', route: 'bell', recipient: 'Bob' };
  const lease = { leaseId: 'a', heartbeatAt: 1, expiresAt: 2 };

  assert.equal(leaseOwnsNotification(lease, mention), true);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'] } }, mention), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Cara' } }, mention), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'], mention: 'Cara' } }, bell), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Bob' } }, mention), true);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Bob' } }, { actor: 'aku/riko', body: 'bare answer', route: 'attention', recipient: 'Bob' }), false);
});

test('a mention-filtered catch leaves listening-only activity eligible at the native boundary', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'listen', actor: 'Bob', target: 'Alice', at: 4 },
    { kind: 'say', actor: 'Alice', body: 'bare answer', at: 5 },
    { kind: 'say', actor: 'Alice', body: 'for Cara @Cara', mentions: ['Cara'], at: 6 },
  ]);
  const lease = { leaseId: 'catch', heartbeatAt: 10, expiresAt: 20, filter: { mention: 'Bob' } };
  const pending = deriveDeliveryModel(square).pendingFor('Bob');
  const before = structuredClone(square);
  assert.deepEqual(pending.map(({ route }) => route), ['attention', 'attention']);
  for (const { item, recipient, route } of pending) {
    assert.equal(leaseOwnsNotification(lease, { ...item, recipient, route }), false);
  }
  assert.deepEqual(square, before, 'lease filtering never records observations');
  const caught = decideCatch(square, 'Bob', { mention: true }, 11);
  assert.deepEqual(caught.delivered, []);
  assert.equal(caught.changed, false);
  assert.deepEqual(square, before, 'excluded notifications stay unread');
  const membership = {
    name: 'Bob', squarePath: '/tmp/listener.square', catchLease: lease,
    notifications: pending.map(({ item, route }) => ({ actIndex: item.index, actor: item.actor, at: item.at, body: item.body, route })),
  };
  assert.deepEqual(pendingAtBoundary([membership]), [membership]);
  assert.deepEqual(decideCatch(square, 'Bob', {}, 12).delivered.map(({ index }) => index), [4, 5]);
});

test('bells satisfy mention filtering but still require the catch sender filter', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'say', actor: 'Alice', body: 'everyone listen', reach: 'bell', at: 4 },
  ]);
  const lease = { leaseId: 'catch', heartbeatAt: 10, expiresAt: 20, filter: { participants: ['Cara'], mention: 'Bob' } };
  const [{ item, recipient, route }] = deriveDeliveryModel(square).pendingFor('Bob');
  const notification = { ...item, recipient, route };
  assert.equal(leaseOwnsNotification(lease, notification), false);
  assert.deepEqual(decideCatch(square, 'Bob', { from: ['Cara'], mention: true }, 11).delivered, []);
  assert.deepEqual(decideCatch(square, 'Bob', { from: ['Cara'] }, 11).delivered, []);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'] } }, notification), false);
  assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['alice'], mention: 'bob' } }, notification), true);
  assert.deepEqual(decideCatch(square, 'BOB', { from: ['alice'], mention: true }, 12).delivered.map(({ index }) => index), [3]);
});

test('a catch lease owns all matching unread notifications beyond the current page', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    ...Array.from({ length: 3 }, (_, index) => ({ kind: 'say', actor: 'Alice', body: `message ${index}`, mentions: ['Bob'], at: index + 3 })),
  ]);
  const lease = { leaseId: 'catch', heartbeatAt: 10, expiresAt: 20, filter: { participants: ['alice'], mention: 'bob' } };
  const owns = ({ item, recipient, route }) => leaseOwnsNotification(lease, { ...item, recipient, route });
  assert.equal(deriveDeliveryModel(square).pendingFor('Bob').every(owns), true);
  const caught = decideCatch(square, 'Bob', { from: ['alice'], mention: true, limit: 1 }, 11);
  assert.deepEqual(caught.delivered.map(({ index }) => index), [2]);
  assert.equal(caught.remaining, 2);
  const pending = deriveDeliveryModel(square).pendingFor('Bob');
  assert.deepEqual(pending.map(({ item }) => item.index), [3, 4]);
  assert.equal(pending.every(owns), true);
});

test('delivery route distinguishes mentioned recipients from listeners on the same say', () => {
  const square = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'listen', actor: 'Cara', target: 'Alice', at: 4 },
    { kind: 'say', actor: 'Alice', body: 'question @Bob', mentions: ['Bob'], at: 5 },
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
      mentions: index % 1_000 === 0 ? ['Bob'] : [],
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
    { kind: 'say', actor: 'Alice', at: 3, body: 'one @Bob', mentions: ['Bob'] },
    { kind: 'say', actor: 'Alice', at: 4, body: 'two @Bob', mentions: ['Bob'] },
    { kind: 'say', actor: 'Alice', at: 5, body: 'three @Bob', mentions: ['Bob'] },
  ]);
  recordObservation(square, 'Bob', 3, 'seen', 8);
  recordObservation(square, 'Bob', 4, 'seen', 9);
  assert.equal(readCursor(square, 'Bob'), 1);
  recordObservation(square, 'Bob', 2, 'seen', 10);
  assert.equal(readCursor(square, 'Bob'), 4);
});
