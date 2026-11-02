import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Channel, ChannelEndpoint, resolveHarnessSession, harnessOwner, decodeHarnessOwner, localUserOwner } from '../dist/channel.js';
import { Square, createSquareResourceOwner } from '../dist/square-api.js';
import { codexWakeAddress } from '../dist/codex-address.js';
import { canonicalPath } from '../dist/canonical-path.js';
import { MAX_IDENTITY_SET_SIZE, parseActivityId } from '../dist/square-core.js';
import { indexedSquareEntries } from '../dist/square-index.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { nativePendingPreview, sessionInbox } from '../dist/inbox.js';
import { nativePayload, observeClaudeDelivery } from '../dist/claude-delivery.js';
import { observeOpenCodeContext } from '../dist/plugins/opencode/delivery.js';

const body = 'Full direct message @unmatched @Other\n' + '正文'.repeat(2600) + '\nTHE END';
const metadata = { job: { id: 7, kind: 'result' } };
const match = { fields: [{ path: ['job', 'id'], equals: 7 }] };
const hash = text => createHash('sha256').update(text).digest('hex');
const invalid = error => ['invalid_args', 'invalid_name'].includes(error.code);

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-channel-'));
  const location = path.join(root, 'scoped.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const channel = await Channel.create({ path: location, env, wakeTransport: false, ...options });
  const square = await Square.at({ path: location, env, wakeTransport: false });
  t.after(async () => { await square.close(); await channel.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, location, env, channel, square };
}

function assertFull(text, sent) {
  assert.ok(text.includes(sent.body));
  assert.doesNotMatch(text, /<square-activity/);
  assert.ok(text.includes('This is an external notification, not a direct message from the user.'));
}

test('harness resolution derives every coordinate and native-first precedence from the shared order', () => {
  assert.equal(resolveHarnessSession({}), undefined);
  assert.equal(resolveHarnessSession({ PI_SESSION_ID: '  ' }), undefined);
  const cases = [
    ['CLAUDE_CODE_SESSION_ID', 'claude-code'], ['CODEX_THREAD_ID', 'codex'], ['OPENCODE_SESSION_ID', 'opencode'],
    ['PI_SESSION_ID', 'pi'], ['PASEO_AGENT_ID', 'paseo'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [variable, channel] = cases[i];
    const env = { CODEX_HOME: '/tmp/channel-codex', SQUARE_CODEX_ENDPOINT: ' /tmp/channel.sock ',
      ...Object.fromEntries(cases.slice(i).map(([name]) => [name, ' later '])), [variable]: ' session:id ' };
    const actual = resolveHarnessSession(env);
    assert.equal(actual.channel, channel);
    assert.equal(actual.sessionId, 'session:id');
    assert.equal(actual.owner, harnessOwner({ channel, session: 'session:id' }));
    assert.deepEqual(actual.wakeAddress, channel === 'codex' ? codexWakeAddress('session:id', env)
      : channel === 'paseo' ? { kind: 'paseo', address: { agentId: 'session:id' } } : undefined);
  }
  const claude = { CLAUDE_CODE_SESSION_ID: ' parent ', CLAUDE_CODE_CHILD_SESSION: ' 1 ', CLAUDE_CODE_AGENT_ID: ' child:id ', PASEO_AGENT_ID: 'manager' };
  assert.deepEqual(resolveHarnessSession(claude), { channel: 'claude-code', sessionId: 'parent', agentId: 'child:id',
    owner: harnessOwner({ channel: 'claude-code', session: 'parent', agent: 'child:id' }) });
  for (const extra of [{ CLAUDE_CODE_CHILD_SESSION: '0' }, { CLAUDE_CODE_AGENT_ID: ' ' }]) {
    const resolved = resolveHarnessSession({ ...claude, ...extra });
    assert.equal(resolved.agentId, undefined);
    assert.equal(resolved.owner, 'claude-code:parent');
  }
  assert.deepEqual(decodeHarnessOwner(resolveHarnessSession(claude).owner), { channel: 'claude-code', session: 'parent', agent: 'child:id' });
  assert.ok(localUserOwner());
});

test('file lifecycle requires an explicit nonblank path even with cwd and SQUARE_LOCATION', async t => {
  const f = await fixture(t);
  for (const open of [Channel.open, Channel.create]) {
    for (const input of [undefined, {}, { path: '' }, { path: ' \t ', cwd: f.root, env: { SQUARE_LOCATION: f.location } }])
      await assert.rejects(open(input), error => error.code === 'invalid_args' && error.message === 'Channel path is required.');
  }
  const reopened = await Channel.open({ path: 'scoped.square', cwd: f.root, env: f.env, wakeTransport: false });
  try {
    assert.equal(reopened.location, f.location);
    assert.deepEqual(await reopened.endpointsOf('test:recipient'), []);
    assert.deepEqual(await indexedSquareEntries({}, f.env), [], 'create/open never publish or auto-attach');
  } finally { await reopened.close(); }
  const first = Channel.inMemory(), second = Channel.inMemory();
  try {
    assert.notEqual(first.location, second.location);
    assert.match(first.location, /^memory:\/\//);
    await first.attach('Recipient', { owner: 'test:recipient' });
    assert.deepEqual(await second.endpointsOf('test:recipient'), []);
  } finally { await first.close(); await second.close(); }
});

test('endpoint custody, generation fencing and index publication share the existing artifact lifecycle', async t => {
  const { channel, env, location } = await fixture(t);
  const owner = 'test:recipient', identity = endpoint => ({ owner, generation: endpoint.generation });
  const endpoint = await channel.attach('Recipient', { owner });
  assert.ok(endpoint instanceof ChannelEndpoint);
  assert.equal((await channel.endpoint('rECIPIENT', { owner })).name, 'Recipient');
  assert.equal((await channel.attach('Recipient', { owner })).generation, endpoint.generation);
  assert.deepEqual(await indexedSquareEntries({ owner }, env), [{ location: await canonicalPath(location), owner }]);
  await assert.rejects(channel.endpoint('Recipient', { owner: 'test:foreign' }), error => error.facts.reason === 'needs_seat');
  await assert.rejects(channel.attach('Recipient', { owner: 'test:foreign' }), error => error.code === 'already_joined');
  assert.equal(await channel.detach('Recipient', { owner: 'test:foreign', generation: endpoint.generation }), null);
  assert.equal(await channel.detach('Recipient', identity(endpoint)), true);
  assert.equal(await channel.detach('Recipient', identity(endpoint)), null);
  assert.deepEqual(await channel.endpointsOf(owner), [{ name: 'Recipient', generation: endpoint.generation, attachment: 'detached' }]);
  await assert.rejects(channel.endpoint('Recipient', { owner }), error => error.facts.reason === 'needs_seat');
  await assert.rejects(endpoint.deferDelivery({ match, durationMs: 1000 }), error => error.code === 'already_joined');
  assert.equal(await channel.reattach('Missing', { owner }), null);
  assert.equal(await channel.reattach('Recipient', { owner: 'test:foreign' }), null);
  const restored = await channel.reattach('Recipient', { owner });
  assert.equal(restored.generation, endpoint.generation);
  const replacement = await channel.attach('Recipient', { owner, takeover: true });
  assert.notEqual(replacement.generation, endpoint.generation);
  assert.equal(await channel.remove('Recipient', identity(endpoint)), false);
  assert.equal(await channel.cancelDeliveries('Recipient', identity(endpoint)), false);
  await assert.rejects(endpoint.leave(), error => error.code === 'already_joined');
  await channel.send({ from: 'Coordinator', to: 'Recipient', body: 'cancel this wake' });
  assert.equal(await channel.cancelDeliveries('Recipient', identity(replacement)), true);
  assert.equal(await channel.cancelDeliveries('Recipient', identity(replacement)), false);
  assert.equal(await channel.detach('Recipient', identity(replacement)), true);
  assert.equal(await channel.remove('Recipient', identity(replacement)), true, 'permanent removal also ends a detached seat');
  assert.equal(await channel.remove('Recipient', identity(replacement)), false);
  assert.equal(await channel.reattach('Recipient', { owner }), null);
  assert.deepEqual(await channel.endpointsOf(owner), []);
  const fresh = await channel.attach('Recipient', { owner });
  await fresh.leave();
  assert.deepEqual(await channel.endpointsOf(owner), []);
});

test('send retains detached recipients without waking them and rejects missing or departed recipients atomically', async t => {
  const attempts = [];
  const { channel, square } = await fixture(t, { wakeTransport: {
    async attempt(request, _timeout, beforeSend) {
      assert.equal(await beforeSend(), true);
      attempts.push(request.participant);
      return { outcome: 'accepted' };
    },
  } });
  const route = name => ({ kind: 'paseo', address: { agentId: `test-${name}` } });
  const alice = await channel.attach('Alice', { owner: 'test:alice', wakeAddress: route('alice') });
  const bob = await channel.attach('Bob', { owner: 'test:bob', wakeAddress: route('bob') });
  assert.equal(await channel.detach('Bob', { owner: 'test:bob', generation: bob.generation }), true);
  const send = { from: 'Coordinator', to: [alice.name, bob.name], body: 'retained while away', metadata };
  const sent = await channel.send(send);
  assert.deepEqual(sent.to, ['Alice', 'Bob']);
  assert.deepEqual(attempts, ['Alice'], 'attachment gates proactive wake, not addressed landing');
  const away = (await square.participants()).participants.find(p => p.name === 'Bob');
  assert.equal(away.presence, 'away');
  assert.equal(away.unreadActivityCount, 0, 'Agora counters exclude native messages');
  assert.equal((await channel.listEndpoints()).find(endpoint => endpoint.name === 'Bob').unreadCount, 1);
  const evidence = (await square.artifact.read(facts => ({
    receipt: facts.receipt('Bob', parseActivityId(sent.id)),
    deliveries: facts.deliveryEvidence('Bob', bob.generation),
  }))).value;
  assert.deepEqual(evidence, { receipt: undefined, deliveries: [] });
  await assert.rejects(bob.pending({ match }), error => error.code === 'already_joined');
  const restored = await channel.reattach('Bob', { owner: 'test:bob' });
  assert.equal(restored.generation, bob.generation);
  const pending = await restored.pending({ match });
  assert.deepEqual(pending.messages.map(m => m.id), [sent.id]);
  assert.equal(pending.messages[0].body, send.body);
  assert.deepEqual(await restored.ack([sent.id]), { consumed: 1 });
  assert.deepEqual(await restored.pending({ match }), { messages: [], remaining: 0 });
  const before = await channel.history({ limit: null });
  await assert.rejects(channel.send({ ...send, to: ['Alice', 'Missing'] }), error => error.facts.reason === 'not_standing');
  assert.deepEqual(await channel.history({ limit: null }), before);
  await restored.leave();
  const departed = await channel.history({ limit: null });
  await assert.rejects(channel.send(send), error => error.facts.reason === 'not_standing');
  assert.deepEqual(await channel.history({ limit: null }), departed);
  assert.deepEqual(attempts, ['Alice'], 'refused recipient batches land and wake nobody');
});

test('unjoined send targets only explicit recipients; boundary hooks present the sent body and consume automatically', async t => {
  const { channel, square, env } = await fixture(t);
  const owner = harnessOwner({ channel: 'pi', session: 'channel-boundary' });
  await channel.attach('Recipient', { owner });
  await channel.attach('Other', { owner: 'test:other' });
  const sent = await channel.send({ from: 'Coordinator', to: ['recipient', 'RECIPIENT'], body, truncate: false, metadata });
  assert.deepEqual(sent, { id: 'act/2', at: sent.at, from: 'Coordinator', to: ['Recipient'], body, metadata });
  const { participants } = await square.participants();
  assert.deepEqual(participants.map(p => p.name).sort(), ['Other', 'Recipient']);
  assert.equal(participants.find(p => p.name === 'Other').pendingMentionCount, 0);
  assert.equal(participants.find(p => p.name === 'Recipient').pendingMentionCount, 0, 'Channel messages never count as Agora attention');
  assert.equal((await channel.listEndpoints()).find(endpoint => endpoint.name === 'Recipient').unreadCount, 1);
  assert.equal((await sessionInbox(owner, env))[0].notifications[0].body, body);
  const presented = await presentPendingAtBoundary(owner, text => text, undefined, env);
  assertFull(presented, sent);
  assert.equal(Boolean((await square.artifact.read(facts => facts.receipt('Recipient', Number(sent.id.slice(4))))).value), true);
  assert.deepEqual((await channel.history({ at: [sent.id] })).messages[0].metadata, metadata);
  assert.deepEqual((await square.history({ at: [sent.id] })).activities, [], 'Agora history excludes native messages');
  assert.equal(await presentPendingAtBoundary(owner, () => assert.fail('must not replay'), undefined, env), undefined);
});

for (const native of ['claude-code', 'opencode']) test(`${native} native hook correlation presents Channel sends in the fixed boundary`, async t => {
  let sentPayload, correlation;
  const session = `channel-${native}`;
  const wakeAddress = native === 'claude-code'
    ? { kind: 'claude-native', address: { sessionId: session, endpoint: '/tmp/channel-test.sock', loaded: 'true' } }
    : { kind: 'opencode-server', address: { sessionId: session } };
  const transport = { async attempt(request, _timeout, beforeSend) {
    const preview = (await request.artifact.read(facts => nativePendingPreview(facts, {
      location: request.location, participant: request.participant, generation: request.seat.generation,
      route: { kind: wakeAddress.kind, address: wakeAddress.address }, index: parseActivityId(request.activity), now: Date.now(),
    }))).value;
    assert.equal(preview.clipped, false);
    assertFull(preview.payload, { id: request.activity, from: 'Coordinator', body });
    sentPayload = native === 'claude-code' ? nativePayload(request.claimToken, preview.payload) : preview.payload;
    correlation = native === 'claude-code'
      ? { harness: 'claude', token: request.claimToken, messageId: 'channel-native', payloadHash: hash(sentPayload) }
      : { harness: 'opencode', token: 'msg_channel', payloadHash: hash(sentPayload) };
    assert.equal(await request.artifact.prepareDelivery({ seat: request.seat, claimToken: request.claimToken, correlation }), true);
    assert.equal(await beforeSend(), true);
    return { outcome: 'accepted' };
  } };
  const { channel, square, env } = await fixture(t, { wakeTransport: transport });
  await channel.attach('Recipient', { owner: harnessOwner({ channel: native, session }), wakeAddress });
  const sent = await channel.send({ from: 'Coordinator', to: 'Recipient', body, truncate: false, metadata });
  assert.ok(sentPayload, 'send invokes the supplied transport');
  assert.equal(Boolean((await square.artifact.read(facts => facts.receipt('Recipient', Number(sent.id.slice(4))))).value), false, 'accepted wake alone is not consumption');
  if (native === 'claude-code') {
    assert.deepEqual(await observeClaudeDelivery(session, sentPayload, 'stored', env), { recognized: true, current: true });
  } else {
    await observeOpenCodeContext(session, [{ id: correlation.token, role: 'user', content: [{ type: 'text', text: sentPayload }] }], env, new AbortController().signal);
  }
  assert.equal(Boolean((await square.artifact.read(facts => facts.receipt('Recipient', Number(sent.id.slice(4))))).value), true);
});

test('attached senders with unread messages bypass Agora gates, caps, throttle and sayCount', async t => {
  const f = await fixture(t);
  // Open an existing capped/throttled Square as a channel; the send primitive still ignores both gates.
  const gated = await Square.build({ path: path.join(f.root, 'gated.square'), env: f.env, markdown: '', hardCap: 1, throttlePerMinute: 1, wakeTransport: false });
  const channel = await Channel.open({ path: gated.location, env: f.env, wakeTransport: false });
  t.after(async () => { await channel.close(); await gated.close(); });
  const sender = await channel.attach('Sender', { owner: 'test:sender' });
  await channel.attach('Recipient', { owner: 'test:recipient' });
  await channel.send({ from: 'Coordinator', to: 'Sender', body: 'unread' });
  for (let i = 0; i < 3; i++) {
    await sender.send({ to: 'Recipient', body: `endpoint ${i}` });
    await channel.send({ from: 'Sender', to: 'Recipient', body: `channel ${i}` });
  }
  const senderState = (await gated.participants()).participants.find(p => p.name === 'Sender');
  assert.equal(senderState.activityCount, 0);
  assert.equal(senderState.unreadActivityCount, 0, 'native messages are not Agora unread activity');
  assert.equal((await channel.listEndpoints()).find(endpoint => endpoint.name === 'Sender').unreadCount, 1);
  assert.equal((await channel.history({ from: ['Sender'], limit: null })).messages.length, 6);
});

test('deferral leases match persisted metadata and release restores boundary eligibility without a new message', async t => {
  let now = Date.now(), attempts = 0;
  const { channel, square, env } = await fixture(t, { clock: () => now, wakeTransport: {
    async attempt(_request, _timeout, beforeSend) { assert.equal(await beforeSend(), true); attempts++; return { outcome: 'accepted' }; },
  } });
  const owner = harnessOwner({ channel: 'pi', session: 'channel-deferred' });
  const endpoint = await channel.attach('Recipient', { owner, wakeAddress: { kind: 'paseo', address: { agentId: 'deferred' } } });
  const lease = await endpoint.deferDelivery({ match, durationMs: 1000 });
  now += 500;
  const renewed = await endpoint.renewDeliveryDeferral(lease.id, 2000);
  assert.equal(renewed.id, lease.id);
  assert.equal(renewed.expiresAt, new Date(now + 2000).toISOString());
  const deferred = await channel.send({ from: 'Coordinator', to: 'Recipient', body, truncate: false, metadata });
  await channel.send({ from: 'Coordinator', to: 'Recipient', body: 'unmatched metadata', metadata: { job: { id: 8 } } });
  assert.equal(attempts, 1, 'matching direct metadata blocks proactive dispatch, not unrelated messages');
  const page = await sessionInbox(owner, env);
  assert.equal(page[0].notifications.some(note => note.actIndex === parseActivityId(deferred.id)), false);
  assert.equal(Boolean((await square.artifact.read(facts => facts.receipt('Recipient', Number(deferred.id.slice(4))))).value), false);
  assert.equal(await endpoint.releaseDeliveryDeferral(lease.id), true);
  assert.equal(await endpoint.releaseDeliveryDeferral(lease.id), false);
  assert.equal(await endpoint.renewDeliveryDeferral(lease.id, 1000), null);
  const presented = await presentPendingAtBoundary(owner, text => text, undefined, env);
  assertFull(presented, deferred);
  assert.equal(Boolean((await square.artifact.read(facts => facts.receipt('Recipient', Number(deferred.id.slice(4))))).value), true);
});

test('send preserves full body in history, stores truncated preview when clipped, and unifies two-layer ack', async t => {
  const { channel, square, env } = await fixture(t);
  const owner = harnessOwner({ channel: 'pi', session: 'channel-truncation' });
  await channel.attach('Recipient', { owner });
  const source = 'a\r\n' + 'x'.repeat(230), normalized = source.replace(/\r\n/g, '\n');
  for (const [input, fullExpected, previewExpected, clipped] of [
    [{ body: source }, normalized, normalized, false],
    [{ body: 'x'.repeat(200) }, 'x'.repeat(200), 'x'.repeat(200), false],
    [{ body: 'short\r\ntext' }, 'short\ntext', 'short\ntext', false],
    [{ body: source, truncate: false }, normalized, normalized, false],
    [{ body: 'abc  \r\nrest', truncate: 5 }, 'abc  \nrest', 'abc… (truncated 5 chars)', true],
    [{ body: source, truncate: 1 }, normalized, 'a… (truncated 231 chars)', true],
    [{ body: source, truncate: 1000 }, normalized, normalized, false],
    [{ body: source, truncate: 231 }, normalized, 'a\n' + 'x'.repeat(229) + '… (truncated 1 chars)', true],
  ]) {
    const sent = await channel.send({ from: 'Coordinator', to: 'Recipient', ...input });
    assert.equal(sent.body, fullExpected, 'send returns the full stored body');
    const stored = (await channel.history({ at: [sent.id] })).messages[0];
    assert.equal(stored.body, fullExpected);
    const presented = await presentPendingAtBoundary(owner, text => text, undefined, env);
    assert.ok(presented.includes(previewExpected), 'presentation shows the explicit preview or the unclipped body');
    assert.doesNotMatch(presented, /<square-activity/);
    assert.ok(presented.includes('This is an external notification, not a direct message from the user.'));
    assert.equal(await presentPendingAtBoundary(owner, () => assert.fail('notification ack blocks replay'), undefined, env), undefined);
    assert.equal(Boolean((await square.artifact.read(facts => facts.receipt('Recipient', Number(sent.id.slice(4))))).value), !clipped);
  }
});

test('send validation and unavailable targets reject atomically, and cancellation before landing leaves no activity', async t => {
  const { channel, square } = await fixture(t);
  const recipient = await channel.attach('Recipient', { owner: 'test:recipient' });
  const send = { from: 'Coordinator', to: 'Recipient', body: 'valid' };
  const before = await channel.history({ limit: null });
  for (const change of [
    { from: '' }, { from: 'bad name' }, { from: 7 }, { to: [] }, { to: Array(MAX_IDENTITY_SET_SIZE + 1).fill('Recipient') },
    { to: null }, { to: ['Recipient', 7] }, { to: ['bad name'] }, { body: '' }, { body: ' \n ' }, { body: null },
    { metadata: [] }, { metadata: { value: undefined } },
  ]) await assert.rejects(channel.send({ ...send, ...change }), invalid);
  for (const truncate of [null, true, 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '200', () => 'x', {}, [], Symbol('truncate')])
    await assert.rejects(channel.send({ ...send, truncate }), error => error.code === 'invalid_args'
      && error.message === 'Channel truncate must be false or a positive integer.');
  await assert.rejects(channel.send({ ...send, to: ['Recipient', 'Missing'] }), error => error.code === 'invalid_args'
    && error.facts.reason === 'not_standing' && error.facts.activityUnsent && assert.deepEqual(error.facts.targets, ['Missing']) === undefined);
  assert.deepEqual(await channel.history({ limit: null }), before);
  const abort = new AbortController();
  abort.abort(new Error('cancel channel send'));
  await assert.rejects(channel.send(send, { signal: abort.signal }), /cancel channel send/);
  assert.deepEqual(await channel.history({ limit: null }), before);
  await recipient.leave();
  await assert.rejects(channel.send(send), error => error.facts.reason === 'not_standing');
});

test('caller-owned artifact lifetime outlives a borrowing channel', async t => {
  const { location, env } = await fixture(t);
  const resources = createSquareResourceOwner();
  t.after(() => resources.close());
  const channel = await Channel.open({ path: location, env, resources, wakeTransport: false });
  await channel.attach('Recipient', { owner: 'test:recipient' });
  await channel.close();
  const reopened = await Channel.open({ path: location, env, resources, wakeTransport: false });
  try {
    assert.equal((await reopened.endpoint('Recipient', { owner: 'test:recipient' })).name, 'Recipient');
  } finally { await reopened.close(); }
});

test('Channel builds carry no Agora warmup, while the Agora resource keeps its guide', async t => {
  const { channel, square } = await fixture(t);
  const warmup = async resource => (await resource.artifact.read(facts => facts.header().warmup)).value;
  assert.deepEqual(await warmup(square), [], 'a channel artifact holds no chatroom tutorial');
  assert.deepEqual(await warmup(channel), []);
  const memory = Channel.inMemory({ description: '# Ephemeral\n' });
  const agora = Square.inMemory({ markdown: '# Agora\n' });
  try {
    assert.deepEqual(await warmup(memory), []);
    assert.ok((await warmup(agora)).length > 0, 'Square.inMemory still injects the participant guide');
  } finally { await memory.close(); await agora.close(); }
});

test('listEndpoints reports every standing endpoint across owners without an owner argument', async t => {
  const { channel } = await fixture(t);
  const recipient = await channel.attach('Recipient', { owner: 'test:recipient',
    wakeAddress: { kind: 'paseo', address: { agentId: 'endpoint-recipient' } } });
  const away = await channel.attach('Away', { owner: 'test:away' });
  await channel.detach('Away', { owner: 'test:away', generation: away.generation });
  await channel.send({ from: 'Coordinator', to: 'Recipient', body: 'unread notice' });
  assert.deepEqual((await channel.listEndpoints()).map(({ name, generation, attachment, deliveryAvailable, unreadCount }) =>
    ({ name, generation, attachment, deliveryAvailable, unreadCount })), [
    { name: 'Recipient', generation: recipient.generation, attachment: 'attached', deliveryAvailable: true, unreadCount: 1 },
    { name: 'Away', generation: away.generation, attachment: 'detached', deliveryAvailable: false, unreadCount: 0 },
  ]);
  const abort = new AbortController();
  abort.abort(new Error('cancel endpoint listing'));
  await assert.rejects(channel.listEndpoints({ signal: abort.signal }), /cancel endpoint listing/);
});

test('endpoint.receive consumes matching messages atomically and reports exact remaining counts', async t => {
  const { channel, square } = await fixture(t);
  const endpoint = await channel.attach('Recipient', { owner: 'test:recipient' });
  const first = await channel.send({ from: 'Worker', to: 'Recipient', body: 'one', metadata });
  const second = await channel.send({ from: 'Worker', to: ['Recipient', 'Recipient'], body: 'two', metadata });
  await channel.send({ from: 'Worker', to: 'Recipient', body: 'other job', metadata: { job: { id: 8 } } });
  assert.deepEqual(await endpoint.receive({ match, limit: 1 }), {
    messages: [{ id: first.id, at: first.at, from: 'Worker', to: ['Recipient'], body: 'one', metadata }], consumed: 1, remaining: 1,
  });
  assert.deepEqual(await endpoint.receive({ match }), {
    messages: [{ id: second.id, at: second.at, from: 'Worker', to: ['Recipient'], body: 'two', metadata }], consumed: 1, remaining: 0,
  });
  assert.deepEqual(await endpoint.receive({ match }), { messages: [], consumed: 0, remaining: 0 });
  assert.equal((await endpoint.pending()).messages.length, 1, 'unmatched messages stay unconsumed');
  assert.equal(Boolean((await square.artifact.read(facts => facts.receipt('Recipient', parseActivityId(first.id)))).value), true);
  for (const limit of [0, 101, 1.5, '10'])
    await assert.rejects(endpoint.receive({ limit }), error => error.code === 'invalid_args'
      && error.message === 'Pending limit must be a positive integer no greater than 100.');
  const abort = new AbortController();
  abort.abort(new Error('cancel receive'));
  await assert.rejects(endpoint.receive({ match }, { signal: abort.signal }), /cancel receive/);
});

test('Channel reads real Agora landed addresses while native messages stay outside the Agora projection', async t => {
  const { channel, square } = await fixture(t);
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  await channel.attach('Bob', { owner: 'test:bob' });
  const bobEndpoint = await channel.endpoint('Bob', { owner: 'test:bob' });
  const bob = await square.participant('Bob', { owner: 'test:bob' });
  await bob.listen('Alice');
  const attention = (await alice.express('listening line')).activity;
  const question = (await bob.express('a question')).activity;
  const reply = (await alice.express({ body: 'an answer', reply: question.id })).activity;
  const channelHistory = (await channel.history({ limit: null })).messages;
  const byId = id => channelHistory.find(message => message.id === id);
  assert.equal(byId(attention.id).body, 'listening line');
  assert.deepEqual(byId(attention.id).to, ['Bob'], 'a listener address is a real landed recipient');
  assert.equal(byId(reply.id).body, 'an answer');
  assert.deepEqual(byId(reply.id).to, ['Bob'], 'a reply address is a real landed recipient');
  assert.deepEqual((await square.history({ at: [attention.id, reply.id] })).activities.map(activity => activity.id), [attention.id, reply.id],
    'Agora history still owns its say records');
  const received = await bobEndpoint.receive();
  assert.deepEqual(received.messages.map(message => message.id).sort(), [attention.id, reply.id].sort());
  assert.deepEqual((await bob.catch()).activities, [], 'Channel consumption records the same receipts Agora catch reads');

  const native = await channel.send({ from: 'Coordinator', to: 'Bob', body: 'native only' });
  assert.deepEqual((await square.history({ at: [native.id] })).activities, [], 'native messages never enter Agora history');
  assert.deepEqual((await bob.catch()).activities, [], 'native messages never enter Agora catch');
  assert.equal((await square.participants()).participants.find(participant => participant.name === 'Bob').unreadActivityCount, 0,
    'native messages never count as Agora unread activity');
  assert.ok((await bobEndpoint.pending()).messages.some(message => message.id === native.id), 'the native message remains in Channel pending');
  assert.ok((await alice.express('still admitted after a native message')).activity.id, 'unread native messages do not block Agora admission');
});

test('a captured endpoint cannot publish after detach or takeover', async t => {
  const { channel } = await fixture(t);
  const owner = 'test:recipient';
  const recipient = await channel.attach('Recipient', { owner });
  await channel.attach('Other', { owner: 'test:other' });
  assert.ok((await recipient.send({ to: 'Other', body: 'current endpoint' })).id);
  assert.equal(await channel.detach('Recipient', { owner, generation: recipient.generation }), true);
  await assert.rejects(recipient.send({ to: 'Other', body: 'detached endpoint' }), error => error.code === 'already_joined');
  await channel.reattach('Recipient', { owner });
  const replacement = await channel.attach('Recipient', { owner, takeover: true });
  await assert.rejects(recipient.send({ to: 'Other', body: 'expired generation' }), error => error.code === 'already_joined');
  assert.ok((await replacement.send({ to: 'Other', body: 'replacement endpoint' })).id);
});
