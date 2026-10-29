import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { writeClaudeNative } from '../dist/packages/agent-delivery/src/claude-native.js';
import { connect } from '../dist/packages/agent-delivery/src/index.js';
import { runClaudeMod } from '../dist/claude-mod.js';
import { observeClaudeDelivery, nativePayload, createClaudeWakeTransport } from '../dist/claude-delivery.js';
import { recordClaudeDeliveryStatus } from '../dist/claude-delivery-status.js';
import { doctorDeliveryHealth } from '../dist/delivery-health.js';
import { createArtifactPort } from '../dist/artifact.js';
import { Square, decodeHarnessOwner } from '../dist/square-api.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { renderPendingAtBoundary } from '../dist/boundary-presentation.js';
import { projectSessionCandidates, sessionInbox } from '../dist/inbox.js';
import { canonicalPathSync } from '../dist/canonical-path.js';

const supported = { skip: process.platform !== 'darwin' };
const claudeBody = "claude-code" + ":" + ('claude-test');
const authorBody = "claude-code" + ":" + ('claude-author');
const bodyHash = text => createHash('sha256').update(text).digest('hex');

async function fixture(t, text = 'hello @Bob', envOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-native-'));
  const squarePath = path.join(root, 'S.square');
  const endpoint = path.join(root, 'in.sock');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl'), SQUARE_DISABLE_PASEO_WAKE: '1', ...envOverrides };
  const author = await Square.build({ path: squarePath, markdown: 'test', env });
  try { await author.join('Alice', { owner: authorBody }); }
  finally { await author.close(); }
  const bob = await Square.at({ path: squarePath, env });
  try { await bob.join('Bob', { owner: claudeBody }); }
  finally { await bob.close(); }

  const frames = [];
  let resolveFrame;
  const firstFrame = new Promise(resolve => { resolveFrame = resolve; });
  const server = net.createServer(socket => {
    let data = '';
    socket.on('data', part => {
      data += part;
      if (data.endsWith('\n')) {
        for (const line of data.trimEnd().split('\n')) frames.push(JSON.parse(line));
        resolveFrame(frames.at(-1));
        data = '';
      }
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const coordinate = { sessionId: 'claude-test', cwd: root, version: '2.1.999', endpoint };
  const bridge = async value => {
    const request = { ...coordinate, ...value };
    if (['start', 'reconcile'].includes(value.operation) && value.endpoint === undefined) request.endpoint = 'relative.sock';
    return JSON.parse(await runClaudeMod(JSON.stringify(request), env));
  };
  const start = await bridge({ operation: 'start' });
  const f = { root, squarePath, env, frames, firstFrame, bridge, coordinate, start,
    bobBody: claudeBody, authorBody, payloads: new Map(), nativeMessages: [], onPrepared: undefined };
  await landSay(f, text, ['Bob']);
  await landSay(f, 'not for Bob', ['Alice']);
  await setWakeAddress(f, { kind: 'claude-native', address: { endpoint } });
  return f;
}

async function artifactReadAt(location, select) {
  const artifact = createArtifactPort(location);
  try { return (await artifact.read(select)).value; }
  finally { await artifact.close(); }
}

async function artifactRead(f, select) { return artifactReadAt(f.squarePath, select); }

async function seatIn(location, participant = 'Bob') {
  return artifactReadAt(location, facts => facts.seat(participant));
}

async function seatFor(f, participant = 'Bob') { return seatIn(f.squarePath, participant); }

async function setWakeAddress(f, wakeAddress, participant = 'Bob', location = f.squarePath) {
  const artifact = createArtifactPort(location);
  try {
    const seat = await artifact.read(facts => facts.seat(participant));
    const current = seat.value;
    if (current === undefined) throw new Error(`Missing artifact seat for ${participant}`);
    const ref = { participant: current.participant, owner: current.owner, generation: current.generation };
    if (wakeAddress?.kind === 'claude-native') wakeAddress = { ...wakeAddress, address: { ...wakeAddress.address, sessionId: decodeHarnessOwner(current.owner).session } };
    await artifact.transactAs({ kind: 'participant', seat: ref }, facts => facts.updateWakeAddress(ref, wakeAddress));
  } finally { await artifact.close(); }
}

async function landSay(f, text, mentions = ['Bob'], location = f.squarePath) {
  const square = await Square.at({ path: location, env: f.env });
  try {
    const result = await (await square.participant('Alice', { owner: f.authorBody })).express(text, { force: true, mentions });
    return Number(result.activity.id.slice('act/'.length));
  } finally { await square.close(); }
}

async function seedSquare(f, location, body, text, participant = 'Bob') {
  const author = await Square.build({ path: location, markdown: 'test', env: f.env });
  try { await author.join('Alice', { owner: f.authorBody }); } finally { await author.close(); }
  const member = await Square.at({ path: location, env: f.env });
  try { await member.join(participant, { owner: body }); } finally { await member.close(); }
  const index = await landSay(f, text, [participant], location);
  await setWakeAddress(f, { kind: 'claude-native', address: { endpoint: f.coordinate.endpoint } }, participant, location);
  return index;
}

async function evidenceIn(location, participant = 'Bob', generation) {
  const seat = await seatIn(location, participant);
  return artifactReadAt(location, facts => facts.deliveryEvidence(participant, generation ?? seat?.generation));
}
async function evidence(f, generation) { return evidenceIn(f.squarePath, 'Bob', generation); }
async function currentEvidence(f) { return evidence(f); }
async function seenIn(location, index = 2, participant = 'Bob') {
  return artifactReadAt(location, facts => facts.receipt(participant, index) === undefined ? undefined : 'seen');
}
async function seen(f, index = 2, participant = 'Bob') { return seenIn(f.squarePath, index, participant); }

async function pendingPayload(f, request) {
  const inbox = await sessionInbox(request.seat.owner, f.env);
  const membership = inbox.find(item => canonicalPathSync(item.location) === canonicalPathSync(request.location)
    && item.seat.participant === request.participant);
  const notification = membership?.notifications.find(note => note.actIndex === Number(request.activity.slice(4)));
  if (membership === undefined || notification === undefined) return undefined;
  return renderPendingAtBoundary([{ ...membership, notifications: [notification] }]);
}

function simulatedNativeTransport(f) {
  return {
    async attempt(request, _timeoutMs, beforeSend) {
      const token = request.claimToken;
      const preview = await pendingPayload(f, request);
      if (token === undefined || preview === undefined) return { outcome: 'not-capable' };
      const text = nativePayload(token, preview);
      const messageId = randomUUID();
      const correlation = { harness: 'claude', token, messageId, payloadHash: bodyHash(text) };
      if (!await request.artifact.prepareDelivery({ seat: request.seat, claimToken: token, correlation }))
        return { outcome: 'not-capable' };
      f.payloads.set(`${canonicalPathSync(request.location)}\0${request.activity}`, text);
      await f.onPrepared?.({ request, correlation, text });
      if (!await beforeSend()) return { outcome: 'not-capable' };
      f.nativeMessages.push({ sessionId: request.route.address.sessionId, messageId, text });
      return { outcome: 'unknown', signature: 'native_admission_unconfirmed' };
    },
  };
}

async function dispatch(f, activity = 2, location = f.squarePath) {
  const artifact = createArtifactPort(location);
  try {
    return await deliverPending({ artifact, transport: simulatedNativeTransport(f), location, activity, now: Date.now() });
  } finally { await artifact.close(); }
}
async function payload(f, activity = 'act/2', location = f.squarePath) {
  const text = f.payloads.get(`${canonicalPathSync(location)}\0${activity}`);
  assert.ok(text, 'expected a prepared artifact-owned native attempt');
  return text;
}
async function stored(f, text) {
  return observeClaudeDelivery(f.coordinate.sessionId, `Another Claude session sent a message:\n${text}\n\nNative peer policy.`, 'stored', f.env);
}
// The local socket adapter reports only byte-write custody. The artifact pipeline is
// exercised separately through its public claim/preparation/completion operations.
test('plain native transport writes tokenless session-targeted NDJSON and records no Square evidence', async t => {
  const f = await fixture(t);
  const result = await writeClaudeNative({ sessionId: 'target', endpoint: f.coordinate.endpoint }, '字\nbody', { deadline: Date.now() + 1000 });
  assert.equal(result.outcome, 'written');
  await f.firstFrame;
  assert.equal(f.frames.length, 1);
  assert.deepEqual(Object.keys(f.frames[0]).sort(), ['message', 'msgV', 'msg_id', 'priority', 'session_id', 'type', 'uuid']);
  assert.equal(f.frames[0].uuid, f.frames[0].msg_id);
  assert.equal(f.frames[0].session_id, 'target');
  assert.deepEqual(f.frames[0].message, { role: 'user', content: '字\nbody' });
  assert.deepEqual(await currentEvidence(f), []);
  assert.equal((await writeClaudeNative({ sessionId: 'target', endpoint: f.coordinate.endpoint }, 'body', { deadline: Date.now() - 1 })).outcome, 'unavailable');
  assert.equal((await writeClaudeNative({ sessionId: 'target', endpoint: path.join(f.root, 'dead.sock') }, 'body', { deadline: Date.now() + 1000 })).outcome, 'unavailable');
});

test('native wake persists the same message id used by both wire identifiers before receiver custody', supported, async t => {
  const f = await fixture(t);
  await setWakeAddress(f, { kind: 'claude-native', address: { endpoint: f.coordinate.endpoint, loaded: 'true' } });
  const artifact = createArtifactPort(f.squarePath);
  try {
    await deliverPending({ artifact, transport: createClaudeWakeTransport(f.env), location: f.squarePath, activity: 2 });
    await f.firstFrame;
    const original = (await currentEvidence(f)).find(row => row.kind === 'wake');
    assert.equal(original.outcome, 'unknown');
    assert.equal(f.frames.length, 1);
    assert.equal(f.frames[0].uuid, original.correlation.messageId);
    assert.equal(f.frames[0].msg_id, original.correlation.messageId);
    assert.equal(await recordClaudeDeliveryStatus({ provider: 'claude', sessionId: f.coordinate.sessionId,
      messageId: f.frames[0].uuid, eventId: randomUUID(), state: 'held', reason: 'no-mode-asserted', observedAt: Date.now() }, f.env), true);
    assert.equal((await currentEvidence(f)).find(row => row.kind === 'wake').outcome, 'unknown');
    assert.equal(await seen(f), undefined);
  } finally { await artifact.close(); }
});

test('native custody is artifact evidence and receiver status never authorizes replay', async t => {
  const f = await fixture(t);
  await dispatch(f);
  const original = (await currentEvidence(f)).find(row => row.kind === 'wake');
  assert.equal(original.outcome, 'unknown');
  assert.equal(f.nativeMessages.length, 1);
  const messageId = original.correlation.messageId;
  const status = { provider: 'claude', sessionId: f.coordinate.sessionId, messageId,
    eventId: randomUUID(), state: 'held', reason: 'no-mode-asserted', observedAt: Date.now() };
  assert.equal(f.nativeMessages[0].messageId, messageId);
  assert.equal(await recordClaudeDeliveryStatus(status, f.env), true);
  assert.equal(await recordClaudeDeliveryStatus(status, f.env), true);
  const held = (await currentEvidence(f)).find(row => row.kind === 'wake');
  assert.deepEqual(held.nativeObservations, [statusObservation(status)]);
  assert.match((await doctorDeliveryHealth(f.squarePath, 0, Date.now(), f.env)).join('\n'), /native held \(no-mode-asserted\)/);
  for (const changed of [{ sessionId: 'another-session' }, { messageId: randomUUID() }, { eventId: 'bad' },
    { state: 'presented' }, { state: 'held', reason: undefined }, { state: 'released' },
    { state: 'dropped', reason: 'not-real' }, { observedAt: NaN }]) {
    assert.equal(await recordClaudeDeliveryStatus({ ...status, ...changed }, f.env), false);
  }
  assert.deepEqual((await currentEvidence(f)).find(row => row.kind === 'wake'), held);
  assert.deepEqual(await f.bridge({ operation: 'status', sessionId: 'wrong', status }), { recorded: false });
  const released = { ...status, eventId: randomUUID(), state: 'released', reason: undefined, observedAt: status.observedAt + 1 };
  assert.deepEqual(await f.bridge({ operation: 'status', status: released }), { recorded: true });
  assert.equal((await currentEvidence(f)).find(row => row.kind === 'wake').outcome, 'unknown');
  assert.equal(await seen(f), undefined);
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 1, 'an unknown attempt is not replayed');
  const text = await payload(f);
  await stored(f, text);
  assert.equal(await seen(f), 'seen');
  const accepted = (await currentEvidence(f)).find(row => row.kind === 'wake');
  assert.equal(accepted.outcome, 'accepted');
  assert.equal((await currentEvidence(f)).filter(row => row.kind === 'presentation' && row.outcome === 'presented').length, 1);
  const dropped = { ...status, eventId: randomUUID(), state: 'dropped', reason: 'expired', observedAt: status.observedAt + 2 };
  assert.equal(await recordClaudeDeliveryStatus(dropped, f.env), true);
  const late = (await currentEvidence(f)).find(row => row.kind === 'wake');
  assert.deepEqual(late.nativeObservations, [statusObservation(status), statusObservation(released), statusObservation(dropped)]);
  const doctor = (await doctorDeliveryHealth(f.squarePath, 0, Date.now(), f.env)).join('\n');
  assert.match(doctor, /no pending delivery attention/);
  assert.match(doctor, /held \(no-mode-asserted\) → released → dropped \(expired\)/);
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 1, 'presented activity is not replayed');
});

function statusObservation({ eventId, messageId, state, reason, observedAt }) {
  return { eventId, messageId, state, ...(reason === undefined ? {} : { reason }), observedAt };
}

test('reconciliation preserves the native seat address and an unknown attempt is never replayed via another adapter', supported, async t => {
  const f = await fixture(t, 'hello @Bob', { PASEO_AGENT_ID: 'managed-agent' });
  await dispatch(f);
  const original = (await currentEvidence(f)).find(row => row.kind === 'wake');
  assert.equal(await recordClaudeDeliveryStatus({ provider: 'claude', sessionId: f.coordinate.sessionId,
    messageId: original.correlation.messageId, eventId: randomUUID(), state: 'held', reason: 'no-mode-asserted', observedAt: Date.now() }, f.env), true);
  const scoped = { ...f.env, CLAUDE_CODE_SESSION_ID: f.coordinate.sessionId };
  const square = await Square.at({ path: f.squarePath, env: scoped });
  try { await (await square.participant('Bob', { owner: claudeBody })).express('*waves*', { force: true, noMention: true }); }
  finally { await square.close(); }
  const reconciled = await f.bridge({ operation: 'reconcile', endpoint: f.coordinate.endpoint });
  assert.equal(reconciled.bindings.length, 1);
  const seat = await seatFor(f);
  assert.equal(seat.wakeAddress.kind, 'claude-native');
  assert.equal(seat.wakeAddress.address.endpoint, f.coordinate.endpoint);
  assert.equal(seat.wakeAddress.address.loaded, 'true');
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 1);
  const held = (await currentEvidence(f)).find(row => row.kind === 'wake');
  assert.equal(held.outcome, 'unknown');
  assert.equal(held.nativeObservations[0].reason, 'no-mode-asserted');
  // Withdrawal may expose a fallback for future attention, never replay unknown bytes.
  await f.bridge({ operation: 'reconcile', endpoint: 'relative.sock' });
  const fallback = await Square.at({ path: f.squarePath, env: scoped });
  try { await fallback.join('Bob', { owner: claudeBody, wakeAddress: { kind: 'paseo', address: { agentId: 'managed-agent' } } }); }
  finally { await fallback.close(); }
  assert.equal((await seatFor(f)).wakeAddress.kind, 'paseo');
  await dispatch(f);
  assert.equal((await currentEvidence(f)).filter(row => row.kind === 'wake').length, 1);
  assert.equal(f.nativeMessages.length, 1);
});

test('a native observation arriving before transport completion remains attached to its attempt', async t => {
  const f = await fixture(t);
  f.onPrepared = async ({ correlation }) => {
    assert.equal(await recordClaudeDeliveryStatus({ provider: 'claude', sessionId: f.coordinate.sessionId,
      messageId: correlation.messageId, eventId: randomUUID(), state: 'held', reason: 'no-mode-asserted', observedAt: Date.now() }, f.env), true);
  };
  await dispatch(f);
  const row = (await currentEvidence(f)).find(item => item.kind === 'wake');
  assert.equal(row.outcome, 'unknown');
  assert.equal(row.nativeObservations.length, 1);
  assert.equal(row.nativeObservations[0].reason, 'no-mode-asserted');
});

test('slow Claude authentication stays within the original deadline and never sends after timeout', async t => {
  const f = await fixture(t);
  const home = path.join(f.root, 'home');
  const sessionsDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const digest = createHash('sha256').update(f.coordinate.endpoint).digest('hex');
  fs.writeFileSync(path.join(sessionsDir, `${process.pid}.${digest}.key`), JSON.stringify({ peerToken: 'a'.repeat(32) }));
  const readdir = fs.promises.readdir;
  const authReads = [];
  t.mock.method(fs.promises, 'readdir', (directory, ...args) => {
    if (directory !== sessionsDir) return readdir(directory, ...args);
    const pending = new Promise(resolve => setTimeout(resolve, 150)).then(() => readdir(directory, ...args));
    authReads.push(pending);
    return pending;
  });
  const stat = fs.promises.stat;
  let scannedKeys = 0;
  t.mock.method(fs.promises, 'stat', (file, ...args) => {
    if (path.dirname(file) === sessionsDir) scannedKeys++;
    return stat(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const target = { sessionId: 'target', endpoint: f.coordinate.endpoint, claudeHome: home };
  const started = Date.now();
  await Promise.all([
    assert.rejects(connect({ harness: 'claude', ...target, timeoutMs: 30 }), { code: 'timeout' }),
    writeClaudeNative({ ...target, env: {} }, 'never sent', { deadline: started + 30 }).then(result => {
      assert.equal(result.outcome, 'unavailable');
      assert.equal(result.code, 'timeout');
    }),
  ]);
  assert.ok(Date.now() - started < 120, 'auth must not hold either caller until the 150ms read completes');
  await Promise.all(authReads);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scannedKeys, 0, 'retired auth must not continue scanning keys');
  assert.equal(f.frames.length, 0);
});

test('cancelling Claude authentication aborts its key read without sending', async t => {
  const f = await fixture(t);
  const home = path.join(f.root, 'home');
  const sessionsDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const digest = createHash('sha256').update(f.coordinate.endpoint).digest('hex');
  const key = path.join(sessionsDir, `${process.pid}.${digest}.key`);
  fs.writeFileSync(key, JSON.stringify({ peerToken: 'a'.repeat(32) }));
  const readFile = fs.promises.readFile;
  const signals = [];
  const controller = new AbortController();
  t.mock.method(fs.promises, 'readFile', (file, options) => {
    if (file !== key) return readFile(file, options);
    signals.push(options?.signal);
    if (signals.length === 2) controller.abort();
    return new Promise(() => {});
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const target = { sessionId: 'target', endpoint: f.coordinate.endpoint, claudeHome: home };
  await Promise.all([
    assert.rejects(connect({ harness: 'claude', ...target, signal: controller.signal }), { code: 'aborted' }),
    writeClaudeNative({ ...target, env: {} }, 'never sent', { deadline: Date.now() + 1000, signal: controller.signal }).then(result => {
      assert.equal(result.outcome, 'unavailable');
      assert.equal(result.code, 'aborted');
    }),
  ]);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal?.aborted));
  assert.equal(f.frames.length, 0);
});

test('manual artifact seats receive a bounded native preview; admission is not presentation', async t => {
  const f = await fixture(t);
  assert.equal(f.start.available, false);
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 1);
  const text = await payload(f);
  assert.match(text, /hello @Bob/);
  assert.equal(text.replace(/^\[square-inbox:[^\]]+\]\n/, '').replace(/\n\[\/square-inbox:[^\]]+\]$/, ''),
    renderPendingAtBoundary(await sessionInbox(f.bobBody, f.env)));
  assert.doesNotMatch(text, /not for Bob/);
  assert.equal(await seen(f), undefined);
  assert.equal((await currentEvidence(f)).find(row => row.kind === 'wake').outcome, 'unknown');
  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, text, 'admitted', f.env), { recognized: true, current: true });
  assert.equal((await currentEvidence(f)).find(row => row.kind === 'wake').outcome, 'accepted');
  assert.equal(await seen(f), undefined);
  await stored(f, text);
  await stored(f, text);
  assert.equal(await seen(f), 'seen');
  assert.equal((await currentEvidence(f)).filter(row => row.kind === 'presentation' && row.outcome === 'presented').length, 1);
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 1, 'presented activity is not replayed');
});

test('a clipped preview stays bounded and admission alone does not consume the activity', async t => {
  const f = await fixture(t, 'x'.repeat(300));
  await dispatch(f);
  const text = await payload(f);
  assert.match(text, /truncated="100 more chars">\nAlice spoke your name\./);
  assert.equal(text.replace(/^\[square-inbox:[^\]]+\]\n/, '').replace(/\n\[\/square-inbox:[^\]]+\]$/, ''),
    renderPendingAtBoundary(await sessionInbox(f.bobBody, f.env)));
  assert.match(text, /as="Bob" id="act\/2"/);
  assert.doesNotMatch(text, /square --|catch --|square_catch/);
  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, text, 'admitted', f.env), { recognized: true, current: true });
  assert.equal(await seen(f), undefined);
  assert.equal((await currentEvidence(f)).find(row => row.kind === 'wake').outcome, 'accepted');
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 1, 'admitted activity is not replayed');
});

test('unmatched or rewritten native text cannot authorize admission or presentation', async t => {
  const f = await fixture(t);
  await dispatch(f);
  const text = await payload(f);
  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, '[square-inbox:invented]\n/tmp/arbitrary.square', 'guard', f.env), { recognized: false, current: false });
  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, text.replace('hello', 'altered'), 'admitted', f.env), { recognized: true, current: false });
  await stored(f, text.replace('hello', 'altered'));
  assert.equal((await currentEvidence(f)).find(row => row.kind === 'wake').outcome, 'unknown');
  assert.equal(await seen(f), undefined);
});

test('a catch receipt committed before a late native append prevents presentation', async t => {
  const f = await fixture(t);
  await dispatch(f);
  const text = await payload(f);
  const artifact = createArtifactPort(f.squarePath);
  try {
    const seat = (await artifact.read(facts => facts.seat('Bob'))).value;
    const ref = { participant: seat.participant, owner: seat.owner, generation: seat.generation };
    await artifact.transactAs({ kind: 'participant', seat: ref }, facts => facts.markSeen('Bob', [2], Date.now()));
  } finally { await artifact.close(); }
  await stored(f, text);
  assert.equal((await currentEvidence(f)).filter(row => row.kind === 'presentation').length, 0);
});

test('cancellation fences an old native payload while later artifact activity can deliver', async t => {
  const f = await fixture(t);
  const originalSeat = await seatFor(f);
  await dispatch(f);
  const old = await payload(f);
  const reloaded = await f.bridge({ operation: 'start' });
  assert.deepEqual(reloaded.bindings, f.start.bindings);
  assert.equal((await seatFor(f)).generation, originalSeat.generation);
  const cancelledAt = Date.now();
  await f.bridge({ operation: 'cancel', cancelAt: cancelledAt, bindings: f.start.bindings });
  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, old, 'guard', f.env), { recognized: true, current: false });
  await stored(f, old);
  assert.equal(await seen(f), undefined);
  await f.bridge({ operation: 'start', cancelAt: cancelledAt, bindings: f.start.bindings, cancelledBindings: f.start.bindings });
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 1, 'cancelled activity is not replayed');
  await setWakeAddress(f, undefined);
  const nextIndex = await landSay(f, 'new @Bob');
  assert.equal(nextIndex, 4);
  await setWakeAddress(f, { kind: 'claude-native', address: { endpoint: f.coordinate.endpoint } });
  await dispatch(f, nextIndex);
  assert.equal(f.nativeMessages.length, 2);
  assert.equal((await currentEvidence(f)).find(row => row.activity === 'act/4' && row.kind === 'wake').outcome, 'unknown');
  const newText = await payload(f, 'act/4');
  await stored(f, newText);
  assert.equal(await seen(f, nextIndex), 'seen');
});

test('a stale native payload cannot present a replacement artifact seat', async t => {
  const f = await fixture(t);
  await dispatch(f);
  const text = await payload(f);
  const prior = await seatFor(f);
  const replacementBody = "claude-code" + ":" + ('replacement-session');
  const replacement = await Square.at({ path: f.squarePath, env: f.env });
  try { await replacement.join('Bob', { owner: replacementBody, takeover: true }); }
  finally { await replacement.close(); }
  assert.deepEqual(await stored(f, text), { recognized: true, current: false });
  const current = await seatFor(f);
  assert.equal(current.owner, replacementBody);
  assert.notEqual(current.generation, prior.generation);
  assert.equal(await seen(f), undefined);
});

test('done retains native token recognition without current authority or presentation', async t => {
  const f = await fixture(t);
  await dispatch(f);
  const text = await payload(f);
  const prior = await seatFor(f);
  const square = await Square.at({ path: f.squarePath, env: f.env });
  try { await (await square.participant('Bob', { owner: claudeBody })).done(); }
  finally { await square.close(); }
  const before = await evidence(f, prior.generation);
  assert.equal(await seatFor(f), undefined);
  for (const operation of ['guard', 'admitted', 'stored'])
    assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, text, operation, f.env), { recognized: true, current: false });
  assert.deepEqual(await evidence(f, prior.generation), before);
  assert.equal(await seen(f), undefined);
});

test('a mixed current and inactive native frame vetoes every token before any side effect', async t => {
  const f = await fixture(t);
  await dispatch(f);
  const old = await payload(f);
  const prior = await seatFor(f);
  const artifact = createArtifactPort(f.squarePath);
  try { await artifact.cancelDeliveries(prior, 2); }
  finally { await artifact.close(); }
  const next = await landSay(f, 'fresh @Bob');
  await dispatch(f, next);
  const fresh = await payload(f, `act/${next}`);
  const before = await currentEvidence(f);
  for (const operation of ['guard', 'admitted', 'stored']) {
    for (const text of [`${fresh}\n${old}`, `${old}\n${fresh}`, `${fresh}\n${fresh.replace('fresh', 'altered')}`])
      assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, text, operation, f.env), { recognized: true, current: false });
    assert.deepEqual(await currentEvidence(f), before);
    assert.equal(await seen(f, next), undefined);
  }
  assert.deepEqual(await stored(f, fresh), { recognized: true, current: true });
  assert.equal(await seen(f, next), 'seen');
  assert.equal(await seen(f, 2), undefined);
});

test('pinned session end cannot retire a replacement artifact seat', supported, async t => {
  const f = await fixture(t);
  const replacementBody = "claude-code" + ":" + ('replacement-session');
  const replacement = await Square.at({ path: f.squarePath, env: f.env });
  try { await replacement.join('Bob', { owner: replacementBody, takeover: true }); }
  finally { await replacement.close(); }
  const result = await f.bridge({ operation: 'end', bindings: f.start.bindings, endedAt: Date.now() });
  assert.deepEqual(result.retired, []);
  const seat = await seatFor(f);
  assert.equal(seat.owner, replacementBody);
  const acts = await artifactRead(f, facts => facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items);
  assert.deepEqual(acts.filter(activity => activity.actor === 'Bob').map(activity => activity.kind), ['join', 'done', 'join']);
});

test('late Claude memberships reconcile, cancellation covers committed joins, and end is participant-scoped', supported, async t => {
  const f = await fixture(t);
  const late = await Square.at({ path: f.squarePath, env: f.env });
  try { await late.join('Late', { owner: claudeBody }); }
  finally { await late.close(); }
  const reconciled = await f.bridge({ operation: 'reconcile' });
  assert.equal(reconciled.bindings.length, 2);
  const after = await Square.at({ path: f.squarePath, env: f.env });
  try { await after.join('After', { owner: claudeBody }); }
  finally { await after.close(); }
  const cancelled = await f.bridge({ operation: 'cancel', bindings: reconciled.bindings,
    cancelledBindings: reconciled.bindings, cancelAt: Date.now() });
  assert.equal(cancelled.cancelledBindings.length, 3);
  const afterSeat = await seatFor(f, 'After');
  assert.ok(await artifactRead(f, facts => facts.cancelledThrough('After', afterSeat.generation)) >= 0);
  const ended = await f.bridge({ operation: 'end', bindings: f.start.bindings, endedAt: Date.now() });
  assert.equal(ended.retired.length, 3);
  const state = await artifactRead(f, facts => ({
    seats: facts.seatsForOwner(claudeBody),
    acts: facts.activityHeads({}, { edge: 'oldest', limit: 30 }).items,
  }));
  assert.deepEqual(state.seats.map(seat => [seat.participant, seat.attachment, seat.wakeAddress]),
    [['After', 'detached', undefined], ['Bob', 'detached', undefined], ['Late', 'detached', undefined]]);
  assert.equal(state.acts.filter(activity => activity.kind === 'done').length, 0);
});

test('a prior cancellation cutoff cannot suppress a replacement generation on repeated reconciliation', supported, async t => {
  const f = await fixture(t);
  const cancelledAt = Date.now();
  await f.bridge({ operation: 'cancel', bindings: f.start.bindings, cancelledBindings: f.start.bindings, cancelAt: cancelledAt });
  const prior = await seatFor(f);
  const replacement = await Square.at({ path: f.squarePath, env: f.env });
  try { await replacement.join('Bob', { owner: claudeBody, takeover: true }); }
  finally { await replacement.close(); }
  const current = await seatFor(f);
  assert.notEqual(current.generation, prior.generation);
  await f.bridge({ operation: 'reconcile', bindings: f.start.bindings, cancelledBindings: f.start.bindings, cancelAt: cancelledAt });
  await f.bridge({ operation: 'reconcile', bindings: f.start.bindings, cancelledBindings: f.start.bindings, cancelAt: cancelledAt });
  assert.equal(await artifactRead(f, facts => facts.cancelledThrough('Bob', current.generation)), undefined);
  assert.equal((await seatFor(f)).generation, current.generation);
});

test('the final native send gate releases a prepared attempt after a catch receipt lands', async t => {
  const f = await fixture(t);
  f.onPrepared = async ({ request }) => {
    await request.artifact.transactAs({ kind: 'participant', seat: request.seat }, facts => facts.markSeen('Bob', [2], Date.now()));
  };
  await dispatch(f);
  assert.equal(f.nativeMessages.length, 0);
  assert.equal(await seen(f), 'seen');
  const row = (await currentEvidence(f)).find(item => item.kind === 'wake');
  assert.equal(row.outcome, 'released');
});

test('an unavailable native endpoint clears only the wake address, not the artifact seat', async t => {
  const f = await fixture(t);
  const result = await f.bridge({ operation: 'start', endpoint: 'relative.sock' });
  assert.equal(result.available, false);
  assert.match(result.diagnostic, /unavailable/);
  const seat = await seatFor(f);
  assert.equal(seat.wakeAddress, undefined);
  assert.equal(seat.owner, f.bobBody);
  assert.equal((await artifactRead(f, facts => facts.participant('Bob'))).joined, true);
});

test('mixed native tokens across two candidate artifacts veto every ordering before any side effect', async t => {
  const f = await fixture(t);
  await dispatch(f);
  const current = await payload(f);

  const otherPath = path.join(f.root, 'other.square');
  const otherIndex = await seedSquare(f, otherPath, claudeBody, 'second @Bob');
  await dispatch(f, otherIndex, otherPath);
  const retired = await payload(f, `act/${otherIndex}`, otherPath);
  assert.notEqual(retired, current);

  const otherSeat = await seatIn(otherPath);
  const otherRef = { participant: otherSeat.participant, owner: otherSeat.owner, generation: otherSeat.generation };
  const otherArtifact = createArtifactPort(otherPath);
  try { await otherArtifact.cancelDeliveries(otherRef, otherIndex); } finally { await otherArtifact.close(); }
  const beforeMain = await evidenceIn(f.squarePath, 'Bob');
  const beforeOther = await evidenceIn(otherPath, 'Bob');

  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, retired, 'guard', f.env), { recognized: true, current: false });
  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, current, 'guard', f.env), { recognized: true, current: true });

  const altered = current.replace('hello', 'altered');
  for (const operation of ['guard', 'admitted', 'stored']) {
    for (const text of [`${current}\n${retired}`, `${retired}\n${current}`, `${current}\n${altered}`])
      assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, text, operation, f.env), { recognized: true, current: false });
    assert.deepEqual(await evidenceIn(f.squarePath, 'Bob'), beforeMain);
    assert.deepEqual(await evidenceIn(otherPath, 'Bob'), beforeOther);
    assert.equal(await seen(f), undefined);
    assert.equal(await seenIn(otherPath), undefined);
  }

  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, retired, 'stored', f.env), { recognized: true, current: false });
  assert.deepEqual(await evidenceIn(otherPath, 'Bob'), beforeOther);
  assert.deepEqual(await stored(f, current), { recognized: true, current: true });
  assert.equal(await seen(f), 'seen');
  assert.equal(await seenIn(otherPath), undefined);
});

test('a retired child-agent candidate is discovered by session and recognized without a current seat or inbox', async t => {
  const f = await fixture(t);
  const childBody = "claude-code" + ":" + (f.coordinate.sessionId) + ":agent:child-agent";
  const childPath = path.join(f.root, 'child.square');
  await seedSquare(f, childPath, childBody, 'child @Bob');
  const childSeat = await seatIn(childPath);
  await dispatch(f, 2, childPath);
  const text = await payload(f, 'act/2', childPath);
  const before = await evidenceIn(childPath, 'Bob', childSeat.generation);

  const child = await Square.at({ path: childPath, env: f.env });
  try { await (await child.participant('Bob', { owner: childBody })).done(); } finally { await child.close(); }

  assert.equal(await seatIn(childPath), undefined);
  assert.deepEqual(await sessionInbox(childBody, f.env), []);
  const candidates = await projectSessionCandidates({ owner: childBody, env: f.env });
  assert.ok(candidates.some(candidate => canonicalPathSync(candidate.location) === canonicalPathSync(childPath)));
  assert.deepEqual(await projectSessionCandidates({ owner: `claude-code:${f.coordinate.sessionId}:agent:unrelated-agent`, env: f.env }), []);

  for (const operation of ['guard', 'admitted', 'stored'])
    assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, text, operation, f.env), { recognized: true, current: false });
  assert.deepEqual(await evidenceIn(childPath, 'Bob', childSeat.generation), before);
  assert.equal(await seenIn(childPath), undefined);
  assert.deepEqual(await observeClaudeDelivery(f.coordinate.sessionId, '[square-inbox:invented-token]\n/tmp/nowhere.square', 'stored', f.env), { recognized: false, current: false });
});
