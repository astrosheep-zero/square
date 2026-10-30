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
  assert.ok(text.includes(`<square-activity id="${sent.id}" from="${sent.from}" to="Recipient">\n`));
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
  assert.equal(participants.find(p => p.name === 'Recipient').pendingMentionCount, 1);
  assert.equal((await sessionInbox(owner, env))[0].notifications[0].body, body);
  const presented = await presentPendingAtBoundary(owner, text => text, undefined, env);
  assertFull(presented, sent);
  assert.equal((await square.snapshot()).delivered('Recipient', sent.id), true);
  assert.deepEqual((await square.history({ at: [sent.id] })).activities[0].metadata, metadata);
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
      routeKind: wakeAddress.kind, address: wakeAddress.address, actIndex: parseActivityId(request.activity), now: Date.now(),
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
  assert.equal((await square.snapshot()).delivered('Recipient', sent.id), false, 'accepted wake alone is not consumption');
  if (native === 'claude-code') {
    assert.deepEqual(await observeClaudeDelivery(session, sentPayload, 'stored', env), { recognized: true, current: true });
  } else {
    await observeOpenCodeContext(session, [{ id: correlation.token, role: 'user', content: [{ type: 'text', text: sentPayload }] }], env, new AbortController().signal);
  }
  assert.equal((await square.snapshot()).delivered('Recipient', sent.id), true);
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
  assert.equal(senderState.unreadActivityCount, 1);
  assert.equal((await gated.history({ from: ['Sender'], limit: null })).activities.filter(a => a.kind === 'say').length, 6);
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
  const deferred = await channel.send({ from: 'Coordinator', to: 'Recipient', body, metadata });
  await channel.send({ from: 'Coordinator', to: 'Recipient', body: 'unmatched metadata', metadata: { job: { id: 8 } } });
  assert.equal(attempts, 1, 'matching direct metadata blocks proactive dispatch, not unrelated messages');
  const page = await sessionInbox(owner, env);
  assert.equal(page[0].notifications.some(note => note.actIndex === parseActivityId(deferred.id)), false);
  assert.equal((await square.snapshot()).delivered('Recipient', deferred.id), false);
  assert.equal(await endpoint.releaseDeliveryDeferral(lease.id), true);
  assert.equal(await endpoint.releaseDeliveryDeferral(lease.id), false);
  assert.equal(await endpoint.renewDeliveryDeferral(lease.id, 1000), null);
  const presented = await presentPendingAtBoundary(owner, text => text, undefined, env);
  assertFull(presented, deferred);
  assert.equal((await square.snapshot()).delivered('Recipient', deferred.id), true);
});

test('send normalizes and truncates once before persisting and returning the final direct body', async t => {
  const { channel, square, env } = await fixture(t);
  const owner = harnessOwner({ channel: 'pi', session: 'channel-truncation' });
  await channel.attach('Recipient', { owner });
  const source = 'a\r\n' + 'x'.repeat(230), normalized = source.replace(/\r\n/g, '\n');
  for (const [input, expected] of [
    [{ body: source }, 'a\n' + 'x'.repeat(198) + '… (truncated 32 chars)'],
    [{ body: 'x'.repeat(200) }, 'x'.repeat(200)],
    [{ body: 'short\r\ntext' }, 'short\ntext'],
    [{ body: source, truncate: false }, normalized],
    [{ body: source, truncate: Infinity }, normalized],
    [{ body: 'abc  \r\nrest', truncate: 5 }, 'abc… (truncated 5 chars)'],
    [{ body: source, truncate: 1 }, 'a… (truncated 231 chars)'],
    [{ body: source, truncate: 1000 }, normalized],
    [{ body: source, truncate: text => { assert.equal(text, normalized); return 'result\r\n' + text; } }, 'result\n' + normalized],
  ]) {
    const sent = await channel.send({ from: 'Coordinator', to: 'Recipient', ...input });
    assert.equal(sent.body, expected);
    const stored = (await square.history({ at: [sent.id] })).activities[0];
    assert.equal(stored.body, expected);
    assert.deepEqual(stored.delivery, { mode: 'direct' });
    const presented = await presentPendingAtBoundary(owner, text => text, undefined, env);
    assertFull(presented, sent);
    assert.equal((await square.snapshot()).delivered('Recipient', sent.id), true);
  }
});

test('send validation and unavailable targets reject atomically, and cancellation before landing leaves no activity', async t => {
  const { channel, square } = await fixture(t);
  const recipient = await channel.attach('Recipient', { owner: 'test:recipient' });
  const send = { from: 'Coordinator', to: 'Recipient', body: 'valid' };
  const before = await square.history({ limit: null });
  for (const change of [
    { from: '' }, { from: 'bad name' }, { from: 7 }, { to: [] }, { to: Array(MAX_IDENTITY_SET_SIZE + 1).fill('Recipient') },
    { to: null }, { to: ['Recipient', 7] }, { to: ['bad name'] }, { body: '' }, { body: ' \n ' }, { body: null },
    { metadata: [] }, { metadata: { value: undefined } },
  ]) await assert.rejects(channel.send({ ...send, ...change }), invalid);
  for (const truncate of [null, true, 0, -1, 1.5, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1, '200', {}, [], Symbol('truncate')])
    await assert.rejects(channel.send({ ...send, truncate }), error => error.code === 'invalid_args'
      && error.message === 'Channel truncate must be false, a positive integer, or a function.');
  for (const out of ['', ' \r\n ', undefined, null, 7, {}, Promise.resolve('async')])
    await assert.rejects(channel.send({ ...send, truncate: () => out }), error => error.code === 'invalid_args'
      && error.message === 'Channel truncate must return a non-empty string.');
  await assert.rejects(channel.send({ ...send, to: ['Recipient', 'Missing'] }), error => error.code === 'invalid_args'
    && error.facts.reason === 'not_standing' && error.facts.activityUnsent && assert.deepEqual(error.facts.targets, ['Missing']) === undefined);
  assert.deepEqual(await square.history({ limit: null }), before);
  const abort = new AbortController();
  abort.abort(new Error('cancel channel send'));
  await assert.rejects(channel.send(send, { signal: abort.signal }), /cancel channel send/);
  assert.deepEqual(await square.history({ limit: null }), before);
  await channel.detach('Recipient', { owner: 'test:recipient', generation: recipient.generation });
  await assert.rejects(channel.send(send), error => error.facts.reason === 'not_standing');
  const absent = await channel.reattach('Recipient', { owner: 'test:recipient' });
  await absent.leave();
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
