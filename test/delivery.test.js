import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { emptyRuntimeState } from '../dist/artifact.js';
import { createMemoryCell } from '../dist/square-storage.js';
import { pendingNotifications, leaseOwnsNotification } from '../dist/delivery.js';
import { perceiveActivity } from '../dist/perception-projection.js';
import { decideCatch } from '../dist/catch-decisions.js';
import { pendingAtBoundary } from '../dist/square-projections.js';
import { previewAttentionBody, renderAttentionPreview } from '../dist/attention-presentation.js';
import { formatActivityId } from '../dist/square-core.js';
import { readCursor } from '../dist/runtime.js';

async function trace(acts, select, observations = {}) {
  const artifact = createMemoryCell({ hardCap: null, preamble: [], warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { ...emptyRuntimeState(acts.length), nextActIndex: acts.length, observations },
  });
  try { return (await artifact.transact(select)).value; }
  finally { await artifact.close(); }
}
const plannedRecipients = (facts, index) => facts.audience(index).map(({ recipient, route }) => `${recipient}:${route}`);

// Expected audience/order is independent of the production landing transition.
test('every reach mode addresses exactly its eligible peers', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'say', actor: 'Alice', at: 4, body: 'hello everyone' },
    { kind: 'say', actor: 'Alice', at: 5, body: 'hello @bob @BOB @Missing', mentions: ['bob', 'BOB', 'Missing'] },
    { kind: 'say', actor: 'Alice', at: 6, body: 'private @cara', mentions: ['cara'] },
    { kind: 'say', actor: 'Alice', at: 7, body: 'attention @Bob', reach: 'bell' },
    { kind: 'say', actor: 'Alice', at: 8, body: 'only @Alice', mentions: ['Alice'] },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 3), []);
    assert.deepEqual(plannedRecipients(facts, 4), ['Bob:mention']);
    assert.deepEqual(plannedRecipients(facts, 5), ['Cara:mention']);
    assert.deepEqual(plannedRecipients(facts, 6), ['Bob:bell', 'Cara:bell']);
    assert.deepEqual(plannedRecipients(facts, 7), []);
  });
});

test('a reply reaches its author with route reply and the full body', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 }, { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'say', actor: 'Bob', at: 4, body: 'question' },
    { kind: 'say', actor: 'Alice', at: 5, body: 'answer', reply: 3 },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 4), ['Bob:reply']);
    assert.deepEqual(pendingNotifications(facts, 'Bob').map(({ item, route }) => `${item.index}:${route}`), ['4:reply']);
    assert.equal(perceiveActivity(facts, facts.activity(4), 'Bob'), 'full');
    assert.equal(perceiveActivity(facts, facts.activity(4), 'Cara'), 'presence');
  });
});

test('reply attention combines with mentions and bells, and skips an absent or ignoring author', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 }, { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'say', actor: 'Bob', at: 4, body: 'question' },
    { kind: 'say', actor: 'Alice', at: 5, body: 'answer @Cara', mentions: ['Cara'], reply: 3 },
    { kind: 'say', actor: 'Alice', at: 6, body: 'answer @Bob', mentions: ['Bob'], reply: 3 },
    { kind: 'say', actor: 'Alice', at: 7, body: 'answer everyone', reach: 'bell', reply: 3 },
    { kind: 'say', actor: 'Alice', at: 8, body: 'note to self', reply: 4 },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 4), ['Cara:mention', 'Bob:reply']);
    assert.deepEqual(plannedRecipients(facts, 5), ['Bob:mention']);
    assert.deepEqual(plannedRecipients(facts, 6), ['Bob:bell', 'Cara:bell']);
    assert.deepEqual(plannedRecipients(facts, 7), []);
  });
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Bob', at: 3, body: 'question' }, { kind: 'done', actor: 'Bob', at: 4 },
    { kind: 'say', actor: 'Alice', at: 5, body: 'late answer', reply: 2 }, { kind: 'join', actor: 'Bob', at: 6 },
    { kind: 'say', actor: 'Bob', at: 7, body: 'again' }, { kind: 'ignore', actor: 'Bob', target: 'Alice', at: 8 },
    { kind: 'say', actor: 'Alice', at: 9, body: 'ignored answer', reply: 6 },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 4), []);
    assert.deepEqual(plannedRecipients(facts, 8), []);
  });
});

test('pending attention is post-join, independent of the read cursor, and closes only with a receipt', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'say', actor: 'Alice', at: 2, body: 'historical @Bob', mentions: ['Bob'] },
    { kind: 'join', actor: 'Bob', at: 3 },
    { kind: 'say', actor: 'Alice', at: 4, body: 'pending @Bob', mentions: ['Bob'] },
    { kind: 'say', actor: 'Bob', at: 5, body: 'self cursor advance' },
  ], (facts) => {
    assert.deepEqual(pendingNotifications(facts, 'bob').map(({ item }) => item.index), [3]);
    assert.equal(decideCatch(facts, 'Bob', { id: formatActivityId(3) }, 6).changed, true);
    assert.deepEqual(pendingNotifications(facts, 'Bob'), []);
    assert.deepEqual(facts.receipt('Bob', 3), { at: 6 });
  }, { Bob: { 'act/4': { state: 'seen', at: 5 } } });
});

test('a participant who has stepped out is not a delivery target', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'done', actor: 'Bob', at: 3 }, { kind: 'say', actor: 'Alice', at: 4, body: 'hey @Bob', mentions: ['Bob'] },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 3), []);
    assert.deepEqual(pendingNotifications(facts, 'Bob'), []);
  });
});

test('listener audience is historical across ignore, done, and rejoin', async () => {
  await trace([
    { kind: 'join', actor: 'Caller', at: 1 }, { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 2 },
    { kind: 'join', actor: 'aku/riko', at: 3 }, { kind: 'say', actor: 'aku/riko', at: 4, body: 'first answer' },
    { kind: 'ignore', actor: 'Caller', target: 'aku/riko', at: 5 }, { kind: 'say', actor: 'aku/riko', at: 6, body: 'ignored answer' },
    { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 7 }, { kind: 'say', actor: 'aku/riko', at: 8, body: 'second answer' },
    { kind: 'done', actor: 'Caller', at: 9 }, { kind: 'say', actor: 'aku/riko', at: 10, body: 'after done' },
    { kind: 'join', actor: 'Caller', at: 11 }, { kind: 'say', actor: 'aku/riko', at: 12, body: 'after rejoin' },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 3), ['Caller:attention']);
    assert.deepEqual(plannedRecipients(facts, 5), []);
    assert.deepEqual(plannedRecipients(facts, 7), ['Caller:attention']);
    assert.deepEqual(plannedRecipients(facts, 9), []);
    assert.deepEqual(plannedRecipients(facts, 11), []);
    assert.equal(perceiveActivity(facts, facts.activity(3), 'Caller'), 'full');
    assert.equal(perceiveActivity(facts, facts.activity(3), 'Observer'), 'presence');
  });
});

test('ignore blocks future mentions and bare delivery until listen clears it', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'ignore', actor: 'Bob', target: 'Alice', at: 3 },
    { kind: 'say', actor: 'Alice', body: 'blocked @Bob', mentions: ['Bob'], at: 4 },
    { kind: 'listen', actor: 'Bob', target: 'Alice', at: 5 },
    { kind: 'say', actor: 'Alice', body: 'bare after listen', at: 6 },
    { kind: 'say', actor: 'Alice', body: 'mention after listen @Bob', mentions: ['Bob'], at: 7 },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 3), []);
    assert.deepEqual(plannedRecipients(facts, 5), ['Bob:attention']);
    assert.deepEqual(plannedRecipients(facts, 6), ['Bob:mention']);
  });
});

test('attention preview distinguishes mention, reply, listening, and everyone’s attention', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Bob', body: 'a question', at: 3 }, { kind: 'listen', actor: 'Bob', target: 'Alice', at: 4 },
    { kind: 'say', actor: 'Alice', body: 'bare thought', at: 5 },
    { kind: 'say', actor: 'Alice', body: 'direct thought', mentions: ['Bob'], at: 6 },
    { kind: 'say', actor: 'Alice', body: 'everyone listen', reach: 'bell', at: 7 },
    { kind: 'say', actor: 'Alice', body: 'an answer', reply: 2, at: 8 },
  ], (facts) => {
    const descriptions = facts.activities([4, 5, 6, 7]).map((act) => {
      const [{ route, recipient }] = facts.audience(act.index);
      return renderAttentionPreview({ squarePath: '/tmp/listener.square', actIndex: act.index, recipient, actor: act.actor, route, body: act.body }).split('\n')[2];
    });
    assert.deepEqual(descriptions, ['● Alice spoke · you’re listening to Alice', '● Alice spoke your name (Bob)',
      '● Alice rang the bell · everyone’s attention', '● Alice answered you (Bob)']);
  });
});

test('attention metadata is separate from unindented Markdown body', () => {
  const body = '*thought*\n\n- item\n  - nested\n\n```js\n  run();\n```';
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a"&<b>.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body });
  assert.equal(rendered, ['<square-activity>', '· /tmp/a"&<b>.square · act/12', '● Alice rang the bell · everyone’s attention', '', body, '</square-activity>'].join('\n'));
});

test('attention body is complete up to the preview boundary', () => {
  assert.equal(previewAttentionBody('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(previewAttentionBody('x'.repeat(201)), `${'x'.repeat(200)}…`);
});

test('clipped attention ends with a labeled caption and a bare read-it-all command', () => {
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body: 'x'.repeat(250) });
  assert.equal(rendered, ['<square-activity>', '· /tmp/a.square · act/12', '● Alice rang the bell · everyone’s attention', '', `${'x'.repeat(200)}…`, '</square-activity>',
    '· clipped — read it all:', `square --location '${path.resolve('/tmp/a.square')}' --as 'Bob' catch --id act/12`].join('\n'));
});

test('unclipped attention has no continuation command', () => {
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body: 'short' });
  assert.doesNotMatch(rendered, /catch --id/);
});

test('a backtick run in the command path stays outside the activity tags', () => {
  const rendered = renderAttentionPreview({ squarePath: '/tmp/a```b.square', actIndex: 12, recipient: 'Bob', actor: 'Alice', route: 'bell', body: 'x'.repeat(201) });
  const lines = rendered.split('\n');
  assert.equal(lines[0], '<square-activity>');
  assert.equal(lines[5], '</square-activity>');
  assert.equal(lines[6], '· clipped — read it all:');
  assert.equal(lines[7], `square --location '${path.resolve('/tmp/a```b.square')}' --as 'Bob' catch --id act/12`);
});

test('a later listen does not retroactively receive an earlier bare say', async () => {
  await trace([
    { kind: 'join', actor: 'Caller', at: 1 }, { kind: 'join', actor: 'aku/riko', at: 2 },
    { kind: 'say', actor: 'aku/riko', at: 3, body: 'too early' }, { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 4 },
  ], (facts) => {
    assert.deepEqual(plannedRecipients(facts, 2), []);
    assert.equal(perceiveActivity(facts, facts.activity(2), 'Caller'), 'presence');
  });
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
  assert.equal(leaseOwnsNotification({ ...lease, filter: { mention: 'Bob' } }, { actor: 'aku/riko', route: 'attention', recipient: 'Bob' }), false);
});

test('a mention-filtered catch leaves listening-only activity eligible at the native boundary', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 }, { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'listen', actor: 'Bob', target: 'Alice', at: 4 }, { kind: 'say', actor: 'Alice', body: 'bare answer', at: 5 },
    { kind: 'say', actor: 'Alice', body: 'for Cara @Cara', mentions: ['Cara'], at: 6 },
  ], (facts) => {
    const lease = { leaseId: 'catch', heartbeatAt: 10, expiresAt: 20, filter: { mention: 'Bob' } };
    const pending = pendingNotifications(facts, 'Bob');
    const before = facts.receiptAssignments();
    assert.deepEqual(pending.map(({ route }) => route), ['attention', 'attention']);
    for (const { item, recipient, route } of pending) assert.equal(leaseOwnsNotification(lease, { ...item, recipient, route }), false);
    assert.deepEqual(facts.receiptAssignments(), before, 'lease filtering never records receipts');
    const caught = decideCatch(facts, 'Bob', { mention: true }, 11);
    assert.deepEqual(caught.delivered, []);
    assert.equal(caught.changed, false);
    assert.deepEqual(facts.receiptAssignments(), before, 'excluded notifications stay unread');
    const membership = { name: 'Bob', squarePath: '/tmp/listener.square', catchLease: lease,
      notifications: pending.map(({ item, route }) => ({ actIndex: item.index, actor: item.actor, at: item.at, body: item.body, route })) };
    assert.deepEqual(pendingAtBoundary([membership]), [membership]);
    assert.deepEqual(decideCatch(facts, 'Bob', {}, 12).delivered.map(({ index }) => index), [4, 5]);
  });
});

test('bells satisfy mention filtering but still require the catch sender filter', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 }, { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'say', actor: 'Alice', body: 'everyone listen', reach: 'bell', at: 4 },
  ], (facts) => {
    const lease = { leaseId: 'catch', heartbeatAt: 10, expiresAt: 20, filter: { participants: ['Cara'], mention: 'Bob' } };
    const [{ item, recipient, route }] = pendingNotifications(facts, 'Bob');
    const notification = { ...item, recipient, route };
    assert.equal(leaseOwnsNotification(lease, notification), false);
    assert.deepEqual(decideCatch(facts, 'Bob', { from: ['Cara'], mention: true }, 11).delivered, []);
    assert.deepEqual(decideCatch(facts, 'Bob', { from: ['Cara'] }, 11).delivered, []);
    assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['Cara'] } }, notification), false);
    assert.equal(leaseOwnsNotification({ ...lease, filter: { participants: ['alice'], mention: 'bob' } }, notification), true);
    assert.deepEqual(decideCatch(facts, 'BOB', { from: ['alice'], mention: true }, 12).delivered.map(({ index }) => index), [3]);
  });
});

test('mention filtering matches a reply to the viewer like a mention', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 }, { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'say', actor: 'Cara', body: 'question', at: 4 }, { kind: 'say', actor: 'Alice', body: 'answer to Cara', reply: 3, at: 5 },
    { kind: 'say', actor: 'Bob', body: 'question', at: 6 }, { kind: 'say', actor: 'Alice', body: 'answer to Bob', reply: 5, at: 7 },
  ], (facts) => {
    const lease = { leaseId: 'catch', heartbeatAt: 10, expiresAt: 20, filter: { mention: 'Bob' } };
    const pending = pendingNotifications(facts, 'Bob');
    assert.deepEqual(pending.map(({ item, route }) => `${item.index}:${route}`), ['6:reply']);
    for (const { item, recipient, route } of pending) assert.equal(leaseOwnsNotification(lease, { ...item, recipient, route }), true);
    assert.deepEqual(decideCatch(facts, 'Bob', { mention: true }, 11).delivered.map(({ index }) => index), [6]);
  });
});

test('a catch lease owns all matching unread notifications beyond the current page', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 },
    ...Array.from({ length: 3 }, (_, index) => ({ kind: 'say', actor: 'Alice', body: `message ${index}`, mentions: ['Bob'], at: index + 3 })),
  ], (facts) => {
    const lease = { leaseId: 'catch', heartbeatAt: 10, expiresAt: 20, filter: { participants: ['alice'], mention: 'bob' } };
    const owns = ({ item, recipient, route }) => leaseOwnsNotification(lease, { ...item, recipient, route });
    assert.equal(pendingNotifications(facts, 'Bob').every(owns), true);
    const caught = decideCatch(facts, 'Bob', { from: ['alice'], mention: true, limit: 1 }, 11);
    assert.deepEqual(caught.delivered.map(({ index }) => index), [2]);
    assert.equal(caught.remaining, 2);
    const pending = pendingNotifications(facts, 'Bob');
    assert.deepEqual(pending.map(({ item }) => item.index), [3, 4]);
    assert.equal(pending.every(owns), true);
  });
});

test('delivery route distinguishes mentioned recipients from listeners on the same say', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 }, { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'listen', actor: 'Cara', target: 'Alice', at: 4 }, { kind: 'say', actor: 'Alice', body: 'question @Bob', mentions: ['Bob'], at: 5 },
  ], (facts) => assert.deepEqual(facts.audience(4), [{ recipient: 'Bob', route: 'mention' }, { recipient: 'Cara', route: 'attention' }]));
});

test('pending projection remains complete across a long history', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 },
    ...Array.from({ length: 4_000 }, (_, index) => ({ kind: 'say', actor: 'Alice', at: index + 3,
      body: index % 1_000 === 0 ? `direct ${index} @Bob` : `undirected ${index}`, mentions: index % 1_000 === 0 ? ['Bob'] : [] })),
  ], (facts) => assert.deepEqual(pendingNotifications(facts, 'Bob').map(({ item }) => item.index), [2, 1_002, 2_002, 3_002]));
});

test('out-of-order observations advance only the continuous seen prefix', async () => {
  await trace([
    { kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'one @Bob', mentions: ['Bob'] },
    { kind: 'say', actor: 'Alice', at: 4, body: 'two @Bob', mentions: ['Bob'] },
    { kind: 'say', actor: 'Alice', at: 5, body: 'three @Bob', mentions: ['Bob'] },
  ], (facts) => {
    facts.markSeen('Bob', [3], 8); facts.markSeen('Bob', [4], 9);
    assert.equal(readCursor(facts, 'Bob'), 1);
    facts.markSeen('Bob', [2], 10);
    assert.equal(readCursor(facts, 'Bob'), 4);
  });
});
