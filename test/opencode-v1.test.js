import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import plugin from '../dist/plugins/opencode-v1/index.js';
import { legacyTransport, nativeMessageId } from '../dist/plugins/opencode-v1/transport.js';
import { startReceiver } from '../dist/plugins/opencode-v1/runtime.js';
import { prepareSquareBuild, writeSquareFile, createArtifactPort, channelArtifact } from '../dist/artifact.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { squareWakeProjection } from '../dist/wake-preview.js';
import { SqliteSquare } from '../dist/sqlite-square.js';
import { createSquareResourceOwner } from '../dist/square-api.js';
import { composedChannel } from './channel-composition.js';
import { rememberSquarePath } from '../dist/square-index.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { installOpenCodePlugin, uninstallOpenCodePlugin, verifyOpenCodeRuntime } from '../dist/harness-links.js';

test('legacy IDs are native shaped, unique and ordered', () => {
  const ids = Array.from({ length: 100 }, nativeMessageId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  assert.ok(ids.every(id => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)));
});

test('v1 prepares before one SDK call and treats 204 or post-call error as uncertain', async () => {
  const events = [];
  const client = { session: { promptAsync: async input => { events.push(['call', input]); return { response: { status: 204 } }; } } };
  const transport = legacyTransport(client, 'ses_a', new AbortController().signal);
  const request = { claimToken: 'claim', message: 'msg/0', route: { kind: 'opencode-server', address: { sessionId: 'ses_a' } },
    presentation: { payload: 'hello', coverage: 'full' }, channel: { prepare: async input => { events.push(['prepare', input]); return true; } } };
  const outcome = await transport.attempt(request, 1000, async () => { events.push(['check']); return true; });
  assert.equal(outcome.outcome, 'unknown');
  assert.deepEqual(events.map(x => x[0]), ['check', 'prepare', 'check', 'call']);
  assert.equal(events[1][1].correlation.token, events[3][1].body.messageID);
  assert.deepEqual(events[3][1].body.parts, [{ type: 'text', text: 'hello' }]);
  client.session.promptAsync = async () => { throw Error('lost'); };
  assert.equal((await transport.attempt(request, 1000, async () => true)).outcome, 'unknown');
  let invoked = false;
  client.session.promptAsync = async () => { invoked = true; };
  assert.equal((await transport.attempt(request, 1000, async () => false)).outcome, 'not-capable');
  assert.equal(invoked, false);
});

test('abort during final beforeSend prevents invoking the v1 SDK', async () => {
  const abort = new AbortController();
  let release, entered, calls = 0, checks = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const atGate = new Promise(resolve => { entered = resolve; });
  const transport = legacyTransport({ session: { promptAsync: async () => { calls++; return {}; } } }, 'ses_a', abort.signal);
  const request = { claimToken: 'claim', message: 'msg/0', route: { kind: 'opencode-server', address: { sessionId: 'ses_a' } },
    presentation: { payload: 'hello', coverage: 'full' }, channel: { prepare: async () => true } };
  const attempt = transport.attempt(request, 1000, async () => { if (++checks === 2) { entered(); await waiting; } return true; });
  await atGate;
  abort.abort(); release();
  assert.equal((await attempt).outcome, 'not-capable');
  assert.equal(calls, 0);
});

test('unavailable native health leaves bounded shell-only integration', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  const diagnostics = [];
  t.mock.method(console, 'warn', text => diagnostics.push(text));
  const hooks = await plugin({ serverUrl: 'http://127.0.0.1', client: { session: {} } });
  assert.match(diagnostics[0], /reduced mode \(no proactive delivery\).*health endpoint unreachable.*embedded TUI/);
  assert.deepEqual(Object.keys(hooks), ['shell.env']);
  const output = { env: {} };
  await hooks['shell.env']({}, output); assert.deepEqual(output.env, {});
  await hooks['shell.env']({ sessionID: 'ses_one' }, output); assert.equal(output.env.OPENCODE_SESSION_ID, 'ses_one');
});

test('health 503 clearly reports reduced mode without proactive delivery', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  const diagnostics = [];
  t.mock.method(console, 'warn', text => diagnostics.push(text));
  const hooks = await plugin({ serverUrl: 'http://127.0.0.1', client: { session: {} } });
  assert.deepEqual(Object.keys(hooks), ['shell.env']);
  assert.match(diagnostics[0], /reduced mode \(no proactive delivery\).*HTTP 503.*embedded TUI/);
});

test('actual v1 transform requires exact associated user parts and can settle before SDK response', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-context-'));
  const oldIndex = process.env.SQUARE_INDEX;
  process.env.SQUARE_INDEX = path.join(root, 'index');
  const location = path.join(root, 'TEST.square');
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'v1');
  state.acts = []; state.runtime.nextActIndex = 0;
  await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  const join = (participant, owner, wakeAddress) => artifact.transactAs({ kind: 'join', participant, owner, wakeAddress }, facts => {
    facts.land({ kind: 'join', actor: participant, at: Date.now() }); return facts.seat(participant);
  }).then(result => result.value);
  const alice = await join('Alice', 'test:author');
  await join('Bob', 'opencode:ses_exact', { kind: 'opencode-server', address: { sessionId: 'ses_exact' } });
  await rememberSquarePath(location, 'opencode:ses_exact', process.env.SQUARE_INDEX);
  let sent, release;
  const calls = [];
  const pending = new Promise(resolve => { release = resolve; });
  const hooks = await startReceiver({ directory: root, project: { id: 'p' }, client: { session: {
    get: async () => ({ data: { id: 'ses_exact', projectID: 'p', directory: root } }),
    promptAsync: async input => { calls.push(input); sent = input; if (calls.length === 1) await pending; return { response: { status: 204 } }; },
  } } });
  t.after(async () => { release(); await hooks.dispose(); await artifact.close();
    if (oldIndex === undefined) delete process.env.SQUARE_INDEX; else process.env.SQUARE_INDEX = oldIndex;
    fs.rmSync(root, { recursive: true, force: true }); });
  await artifact.transactAs({ kind: 'participant', seat: alice }, facts => facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'exact v1', mentions: ['Bob'] }));
  const deadline = Date.now() + 4000;
  while (!sent) { assert.ok(Date.now() < deadline, 'native SDK call was not made'); await sleep(10); }
  const id = sent.body.messageID, text = sent.body.parts[0].text;
  const message = { info: { id, sessionID: 'ses_exact', role: 'user' }, parts: [{ type: 'text', text, messageID: id, sessionID: 'ses_exact' }] };
  const transform = messages => hooks['experimental.chat.messages.transform']({}, { messages });
  const receipt = () => artifact.read(facts => facts.channel.receipt('Bob', 0)).then(result => result.value);
  const filePart = { type: 'file', sessionID: 'ses_exact', messageID: id, mime: 'text/plain', url: 'file:///example' };
  for (const parts of [[{ ...message.parts[0], synthetic: true }], [{ ...message.parts[0], ignored: true }],
    [filePart], [message.parts[0], filePart]]) {
    await transform([{ ...message, parts }]);
    const facts = (await artifact.read(f => ({ receipt: f.channel.receipt('Bob', 0), evidence: f.deliveryEvidence('Bob', f.seat('Bob').generation) }))).value;
    assert.equal(facts.receipt, undefined);
    assert.equal(facts.evidence.some(row => row.kind === 'presentation'), false);
  }
  await transform([{ ...message, parts: [{ ...message.parts[0], messageID: 'wrong' }] }]);
  await transform([{ ...message, parts: [{ ...message.parts[0], text: text + 'changed' }] }]);
  await transform([message, { info: { sessionID: 'ses_other' }, parts: [] }]);
  assert.equal(await receipt(), undefined);
  await transform([message]);
  assert.ok(await receipt(), 'exact transform may settle while SDK call is still pending');
  await transform([message]);
  const evidence = (await artifact.read(facts => facts.deliveryEvidence('Bob', facts.seat('Bob').generation))).value;
  assert.equal(evidence.filter(row => row.kind === 'presentation').length, 1);
  release();
  const resources = createSquareResourceOwner();
  const channel = composedChannel(location, resources, { env: process.env });
  try {
    const clipped = await channel.send({ from: 'Alice', to: 'Bob', body: 'long clipped body', truncate: 4 });
    while (calls.length < 2) { assert.ok(Date.now() < deadline, 'clipped native input not sent'); await sleep(10); }
    const input = calls[1], token = input.body.messageID;
    await transform([{ info: { id: token, sessionID: 'ses_exact', role: 'user' },
      parts: [{ type: 'text', text: input.body.parts[0].text, sessionID: 'ses_exact', messageID: token }] }]);
    const index = Number(clipped.id.slice(4));
    const facts = (await artifact.read(f => ({ receipt: f.channel.receipt('Bob', index), evidence: f.deliveryEvidence('Bob', f.seat('Bob').generation, clipped.id) }))).value;
    assert.equal(facts.receipt, undefined, 'clipped input remains catchable');
    assert.ok(facts.evidence.some(row => row.kind === 'wake' && row.coverage === 'clipped'));
    assert.ok(facts.evidence.some(row => row.kind === 'presentation' && row.outcome === 'clipped'));
    const endpoint = await channel.endpoint('Bob', { owner: 'opencode:ses_exact' });
    const caught = await endpoint.receive();
    assert.ok(caught.messages.some(item => item.id === clipped.id && item.body === 'long clipped body'));
    const late = await channel.send({ from: 'Alice', to: 'Bob', body: 'in flight before takeover' });
    while (calls.length < 3) { assert.ok(Date.now() < deadline, 'later native input not sent'); await sleep(10); }
    const lateInput = calls[2], lateToken = lateInput.body.messageID;
    const bob = (await artifact.read(f => f.seat('Bob'))).value;
    await artifact.transactAs({ kind: 'takeover', participant: 'Bob', owner: 'test:replacement', expectedGeneration: bob.generation }, f => {
      f.land({ kind: 'done', actor: 'Bob', at: Date.now() }); f.land({ kind: 'join', actor: 'Bob', at: Date.now() });
    });
    await transform([{ info: { id: lateToken, sessionID: 'ses_exact', role: 'user' },
      parts: [{ type: 'text', text: lateInput.body.parts[0].text, sessionID: 'ses_exact', messageID: lateToken }] }]);
    assert.equal((await artifact.read(f => f.channel.receipt('Bob', Number(late.id.slice(4))))).value, undefined,
      'a late transform cannot consume under replacement ownership');
  } finally { await channel.close(); await resources.close(); }
});

test('v1 SDK timeout is uncertain in real custody and cannot replay automatically', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-timeout-'));
  const location = path.join(root, 'TEST.square');
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'v1-timeout');
  state.acts = []; state.runtime.nextActIndex = 0; await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  t.after(async () => { await artifact.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const join = (participant, owner, wakeAddress) => artifact.transactAs({ kind: 'join', participant, owner, wakeAddress }, facts => {
    facts.land({ kind: 'join', actor: participant, at: Date.now() }); return facts.seat(participant);
  }).then(result => result.value);
  const alice = await join('Alice', 'test:author');
  const bob = await join('Bob', 'opencode:ses_timeout', { kind: 'opencode-server', address: { sessionId: 'ses_timeout' } });
  const message = (await artifact.transactAs({ kind: 'participant', seat: alice }, facts => facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'timeout', mentions: ['Bob'] }))).value.messageIndex;
  let calls = 0;
  const transport = legacyTransport({ session: { promptAsync: async () => { calls++; return new Promise(() => {}); } } }, 'ses_timeout', new AbortController().signal);
  const dispatch = () => deliverPending({ artifact: channelArtifact(artifact), preparePresentation: squareWakeProjection(artifact), transport, location, message, timeoutMs: 150 });
  await dispatch(); await dispatch();
  const facts = (await artifact.read(f => ({ evidence: f.deliveryEvidence('Bob', bob.generation, `msg/${message}`), receipt: f.channel.receipt('Bob', message) }))).value;
  assert.equal(calls, 1);
  assert.ok(facts.evidence.some(row => row.kind === 'wake' && row.outcome === 'unknown'));
  assert.equal(facts.receipt, undefined);
});

test('v1 final send respects a real deferral committed immediately after preparation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-deferral-'));
  const location = path.join(root, 'TEST.square');
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'v1-deferral');
  state.acts = []; state.runtime.nextActIndex = 0; await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  const resources = createSquareResourceOwner();
  const channel = composedChannel(location, resources);
  t.after(async () => { await channel.close(); await resources.close(); await artifact.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const join = (participant, owner, wakeAddress) => artifact.transactAs({ kind: 'join', participant, owner, wakeAddress }, facts => {
    facts.land({ kind: 'join', actor: participant, at: Date.now() }); return facts.seat(participant);
  }).then(result => result.value);
  const alice = await join('Alice', 'test:author');
  const bob = await join('Bob', 'opencode:ses_deferred', { kind: 'opencode-server', address: { sessionId: 'ses_deferred' } });
  const message = (await artifact.transactAs({ kind: 'participant', seat: alice }, facts => facts.land({ kind: 'say', actor: 'Alice', at: Date.now(),
    body: 'defer this', metadata: { job: { id: 7 } }, mentions: ['Bob'] }))).value.messageIndex;
  const endpoint = await channel.endpoint('Bob', { owner: bob.owner });
  const real = channelArtifact(artifact);
  let lease, preparations = 0, calls = 0;
  const gated = { ...real, async prepareDelivery(input, signal) {
    const prepared = await real.prepareDelivery(input, signal);
    if (prepared) {
      preparations++;
      lease = await endpoint.deferDelivery({ match: { fields: [{ path: ['job', 'id'], equals: 7 }] }, durationMs: 10000 });
    }
    return prepared;
  } };
  const transport = legacyTransport({ session: { promptAsync: async () => { calls++; return { response: { status: 204 } }; } } }, 'ses_deferred', new AbortController().signal);
  await deliverPending({ artifact: gated, preparePresentation: squareWakeProjection(artifact), transport, location, message, timeoutMs: 1000 });
  const facts = (await artifact.read(f => ({ evidence: f.deliveryEvidence('Bob', bob.generation, `msg/${message}`),
    deferrals: f.deliveryDeferrals('Bob', bob.generation), receipt: f.channel.receipt('Bob', message) }))).value;
  assert.equal(preparations, 1, 'real claim correlation was prepared first');
  assert.ok(facts.evidence.some(row => row.correlation?.token && row.outcome === 'released'));
  assert.ok(facts.deferrals.some(row => row.id === lease.id), 'the real matching deferral committed');
  assert.equal(calls, 0, 'the v1 SDK must not run after the final gate sees the deferral');
  assert.equal(facts.receipt, undefined);
});

test('v1 deletion authenticates project and captures late seats, fencing replacement generations', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-delete-'));
  const oldIndex = process.env.SQUARE_INDEX; process.env.SQUARE_INDEX = path.join(root, 'index');
  const location = path.join(root, 'TEST.square');
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'v1-delete');
  state.acts = []; state.runtime.nextActIndex = 0; await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  const join = participant => artifact.transactAs({ kind: 'join', participant, owner: 'opencode:ses_deleted' }, facts => {
    facts.land({ kind: 'join', actor: participant, at: Date.now() }); return facts.seat(participant);
  }).then(result => result.value);
  const bob = await join('Bob');
  await rememberSquarePath(location, 'opencode:ses_deleted', process.env.SQUARE_INDEX);
  let releaseGet, enteredGet, releaseEnd, enteredEnd, sends = 0;
  const waitingGet = new Promise(resolve => { releaseGet = resolve; });
  const atGet = new Promise(resolve => { enteredGet = resolve; });
  const waitingEnd = new Promise(resolve => { releaseEnd = resolve; });
  const atEnd = new Promise(resolve => { enteredEnd = resolve; });
  const endHeld = SqliteSquare.prototype.endHeld;
  t.mock.method(SqliteSquare.prototype, 'endHeld', async function(name, identity) {
    if (name === 'Bob') { enteredEnd(); await waitingEnd; }
    return endHeld.call(this, name, identity);
  });
  const hooks = await startReceiver({ directory: root, project: { id: 'p' }, client: { session: {
    get: async () => { enteredGet(); await waitingGet; return { data: { id: 'ses_deleted', projectID: 'p', directory: root } }; },
    promptAsync: async () => { sends++; return { response: { status: 204 } }; },
  } } });
  t.after(async () => { releaseGet(); releaseEnd(); await hooks.dispose(); await artifact.close();
    if (oldIndex === undefined) delete process.env.SQUARE_INDEX; else process.env.SQUARE_INDEX = oldIndex;
    fs.rmSync(root, { recursive: true, force: true }); });
  await atGet;
  const event = (projectID, directory) => hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_deleted', projectID, directory } } } });
  await event('other', root);
  await event('p', path.dirname(root));
  assert.ok((await artifact.read(facts => facts.seat('Bob'))).value);
  await join('Late');
  const deletion = event('p', root);
  await sleep(20); // allow canonical-path authentication while the first reconcile is held
  releaseGet();
  await atEnd;
  await artifact.transactAs({ kind: 'takeover', participant: 'Bob', owner: 'test:replacement', expectedGeneration: bob.generation }, facts => {
    facts.land({ kind: 'done', actor: 'Bob', at: Date.now() }); facts.land({ kind: 'join', actor: 'Bob', at: Date.now() });
  });
  releaseEnd(); await deletion;
  const seats = (await artifact.read(facts => ({ bob: facts.seat('Bob'), late: facts.seat('Late') }))).value;
  assert.equal(seats.bob.owner, 'test:replacement');
  assert.equal(seats.late, undefined);
  await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { id: 'msg_old', sessionID: 'ses_deleted', role: 'user' }, parts: [] }] });
  await sleep(30); assert.equal(sends, 0);
});

test('an exact v1 transform after authenticated deletion cannot consume or restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-late-delete-'));
  const oldIndex = process.env.SQUARE_INDEX; process.env.SQUARE_INDEX = path.join(root, 'index');
  const location = path.join(root, 'TEST.square');
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'v1-late-delete');
  state.acts = []; state.runtime.nextActIndex = 0; await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  const join = (participant, owner, wakeAddress) => artifact.transactAs({ kind: 'join', participant, owner, wakeAddress }, f => {
    f.land({ kind: 'join', actor: participant, at: Date.now() }); return f.seat(participant);
  }).then(result => result.value);
  const alice = await join('Alice', 'test:author');
  await join('Bob', 'opencode:ses_late', { kind: 'opencode-server', address: { sessionId: 'ses_late' } });
  await rememberSquarePath(location, 'opencode:ses_late', process.env.SQUARE_INDEX);
  const calls = [];
  const hooks = await startReceiver({ directory: root, project: { id: 'p' }, client: { session: {
    get: async () => ({ data: { id: 'ses_late', projectID: 'p', directory: root } }),
    promptAsync: async input => { calls.push(input); return { response: { status: 204 } }; },
  } } });
  t.after(async () => { await hooks.dispose(); await artifact.close();
    if (oldIndex === undefined) delete process.env.SQUARE_INDEX; else process.env.SQUARE_INDEX = oldIndex;
    fs.rmSync(root, { recursive: true, force: true }); });
  const message = (await artifact.transactAs({ kind: 'participant', seat: alice }, f => f.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'late context', mentions: ['Bob'] }))).value.messageIndex;
  const deadline = Date.now() + 4000;
  while (!calls.length) { assert.ok(Date.now() < deadline); await sleep(10); }
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_late', projectID: 'p', directory: root } } } });
  const input = calls[0], id = input.body.messageID;
  await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { id, sessionID: 'ses_late', role: 'user' },
    parts: [{ type: 'text', text: input.body.parts[0].text, sessionID: 'ses_late', messageID: id }] }] });
  assert.equal((await artifact.read(f => f.channel.receipt('Bob', message))).value, undefined);
  assert.equal((await artifact.read(f => f.seat('Bob'))).value, undefined);
  await sleep(50); assert.equal(calls.length, 1);
});

test('v1 drops receiver authority after project validation fails and ignores unrelated deletion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-project-'));
  const oldIndex = process.env.SQUARE_INDEX; process.env.SQUARE_INDEX = path.join(root, 'index');
  const location = path.join(root, 'TEST.square');
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'v1-project');
  state.acts = []; state.runtime.nextActIndex = 0; await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  const join = (participant, owner) => artifact.transactAs({ kind: 'join', participant, owner }, f => {
    f.land({ kind: 'join', actor: participant, at: Date.now() }); return f.seat(participant);
  }).then(result => result.value);
  const alice = await join('Alice', 'test:author');
  await join('Bob', 'opencode:ses_project');
  await rememberSquarePath(location, 'opencode:ses_project', process.env.SQUARE_INDEX);
  let projectID = 'p', sends = 0;
  const hooks = await startReceiver({ directory: root, project: { id: 'p' }, client: { session: {
    get: async () => ({ data: { id: 'ses_project', projectID, directory: root } }),
    promptAsync: async () => { sends++; return { response: { status: 204 } }; },
  } } });
  t.after(async () => { await hooks.dispose(); await artifact.close();
    if (oldIndex === undefined) delete process.env.SQUARE_INDEX; else process.env.SQUARE_INDEX = oldIndex;
    fs.rmSync(root, { recursive: true, force: true }); });
  const transform = () => hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { id: 'msg_test', sessionID: 'ses_project', role: 'user' }, parts: [] }] });
  await transform(); // validates and starts the receiver before project changes
  projectID = 'other'; await transform();
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_project', projectID: 'other', directory: root } } } });
  await artifact.transactAs({ kind: 'participant', seat: alice }, f => f.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'not for this project', mentions: ['Bob'] }));
  await sleep(100);
  assert.equal(sends, 0);
  assert.equal((await artifact.read(f => f.seat('Bob'))).value.owner, 'opencode:ses_project');
});

test('v1 dispose is bounded and idempotent even if native validation never returns', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-dispose-'));
  const oldIndex = process.env.SQUARE_INDEX; process.env.SQUARE_INDEX = path.join(root, 'index');
  const location = path.join(root, 'TEST.square');
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'v1-dispose');
  state.acts = []; state.runtime.nextActIndex = 0; await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  await artifact.transactAs({ kind: 'join', participant: 'Bob', owner: 'opencode:ses_stalled' }, facts => facts.land({ kind: 'join', actor: 'Bob', at: Date.now() }));
  await rememberSquarePath(location, 'opencode:ses_stalled', process.env.SQUARE_INDEX);
  let entered;
  const atGet = new Promise(resolve => { entered = resolve; });
  const hooks = await startReceiver({ directory: root, project: { id: 'p' }, client: { session: {
    get: async () => { entered(); return new Promise(() => {}); }, promptAsync: async () => ({}),
  } } });
  t.after(async () => { await hooks.dispose(); await artifact.close();
    if (oldIndex === undefined) delete process.env.SQUARE_INDEX; else process.env.SQUARE_INDEX = oldIndex;
    fs.rmSync(root, { recursive: true, force: true }); });
  await atGet;
  const start = Date.now();
  const first = hooks.dispose(); assert.equal(hooks.dispose(), first);
  await first;
  assert.ok(Date.now() - start < 4000, 'disposal must not wait forever on the native SDK');
  assert.equal((await artifact.read(f => f.seat('Bob'))).value.owner, 'opencode:ses_stalled', 'unload preserves membership');
});

test('major one installs only owned file URL and diagnoses moved file without removing lookalikes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-install-'));
  const prev = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  t.after(() => { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; fs.rmSync(root, { recursive: true, force: true }); });
  const config = path.join(root, 'config/opencode/opencode.jsonc'); fs.mkdirSync(path.dirname(config), { recursive: true });
  const previous = path.join(root, 'gone/node_modules/@astrosheep/square');
  fs.mkdirSync(previous, { recursive: true });
  fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: '@astrosheep/square' }));
  const old = pathToFileURL(path.join(previous, 'dist/plugins/opencode-v1/index.js')).href;
  const lookalike = pathToFileURL(path.join(root, 'other/dist/plugins/opencode-v1/index.js')).href;
  fs.writeFileSync(config, JSON.stringify({ plugin: [old, lookalike], plugins: ['other'] }));
  assert.match(verifyOpenCodeRuntime(root), /plugin file missing/);
  const source = fs.readFileSync(config, 'utf8');
  assert.throws(() => installOpenCodePlugin(root, false, () => ({ status: 0, stdout: '3.0.0', stderr: '' })), /Unsupported OpenCode version/);
  assert.equal(fs.readFileSync(config, 'utf8'), source);
  const calls = [];
  installOpenCodePlugin(root, false, (_home, args) => { calls.push(args); return { status: 0, stdout: '1.19.5', stderr: '' }; });
  const parsed = JSON.parse(fs.readFileSync(config));
  assert.deepEqual(calls, [['--version']]);
  assert.equal(parsed.plugin.length, 2); assert.equal(parsed.plugin[0], lookalike); assert.match(parsed.plugin[1], /^file:/);
  assert.deepEqual(parsed.plugins, ['other']);
  assert.match(verifyOpenCodeRuntime(root), /ownership unverified/);
  installOpenCodePlugin(root, false, (_home, args) => { calls.push(args); return { status: 0, stdout: '1.19.5', stderr: '' }; });
  assert.deepEqual(JSON.parse(fs.readFileSync(config)), parsed);
  uninstallOpenCodePlugin(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(config)).plugin, [lookalike]);
});

test('v1 lookalike paths with missing or wrong manifests are preserved and diagnosed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-unproven-'));
  const prev = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  t.after(() => { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; fs.rmSync(root, { recursive: true, force: true }); });
  const config = path.join(root, 'config/opencode/opencode.json'); fs.mkdirSync(path.dirname(config), { recursive: true });
  const missing = path.join(root, 'missing/node_modules/@astrosheep/square');
  const wrong = path.join(root, 'wrong/node_modules/@astrosheep/square');
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(wrong, 'package.json'), JSON.stringify({ name: 'someone-else' }));
  const urls = [missing, wrong].map(dir => pathToFileURL(path.join(dir, 'dist/plugins/opencode-v1/index.js')).href);
  for (const url of urls) {
    const source = JSON.stringify({ plugin: [url] });
    fs.writeFileSync(config, source);
    assert.match(verifyOpenCodeRuntime(root), /ownership unverified/);
    assert.deepEqual(uninstallOpenCodePlugin(root), []);
    assert.equal(fs.readFileSync(config, 'utf8'), source);
    installOpenCodePlugin(root, false, () => ({ status: 0, stdout: '1.19.5', stderr: '' }));
    assert.ok(JSON.parse(fs.readFileSync(config)).plugin.includes(url));
    assert.match(verifyOpenCodeRuntime(root), /ownership unverified/);
    uninstallOpenCodePlugin(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(config)).plugin, [url]);
  }
});
