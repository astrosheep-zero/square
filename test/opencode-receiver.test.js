import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createArtifactPort, prepareSquareBuild, writeSquareFile } from '../dist/artifact.js';
import { automaticWakeEligible } from '../dist/delivery.js';
import { observeSessionPending } from '../dist/inbox.js';
import { rememberSquarePath } from '../dist/square-index.js';
import { receiveOpenCodePending, observeOpenCodeContext } from '../dist/plugins/opencode/delivery.js';

async function until(predicate, message) {
  const deadline = Date.now() + 4_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(10);
  }
}
const accepted = input => ({ ...input, type: 'user', payload: { text: input.text }, time: { created: Date.now() } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-opencode-receiver-'));
  const location = path.join(root, 'TEST.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'receiver');
  state.acts = [];
  state.runtime.nextActIndex = 0;
  await writeSquareFile(location, state);
  const artifact = createArtifactPort(location);
  const body = { channel: 'opencode', session: 'native-session' };
  const join = (participant, body, wakeAddress) => artifact.transactAs({ kind: 'join', participant, body, wakeAddress }, facts => {
    facts.land({ kind: 'join', actor: participant, at: Date.now() });
    return facts.seat(participant);
  }).then(result => result.value);
  const alice = await join('Alice', { channel: 'test', session: 'author' });
  const bob = await join('Bob', body, { kind: 'opencode-server', address: { sessionId: body.session } });
  const say = text => artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: text, mentions: ['Bob'] })).then(result => result.value.index);
  const bind = () => rememberSquarePath(location, body, env.SQUARE_INDEX);
  const evidence = index => artifact.read(facts => facts.deliveryEvidence('Bob', bob.generation, `act/${index}`)).then(result => result.value);
  const receipt = index => artifact.read(facts => facts.receipt('Bob', index)).then(result => result.value);
  const receivers = [];
  const start = prompt => {
    const abort = new AbortController();
    const running = receiveOpenCodePending({ sessionId: body.session, session: { get: async () => ({ id: body.session }), prompt } }, env, abort.signal);
    // Retain any unexpected receiver failure until cleanup asserts it.
    void running.catch(() => {});
    const receiver = { abort, running };
    receivers.push(receiver);
    return receiver;
  };
  t.after(async () => {
    for (const receiver of receivers) receiver.abort.abort();
    await Promise.all(receivers.map(receiver => receiver.running));
    await artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { location, env, artifact, body, alice, bob, say, bind, evidence, receipt, start };
}

// Native acceptance/uncertainty remains presentation-pending for all shared observers.
// Only automatic wake preselection applies the additional evidence policy.
test('automatic wake evidence is separate from presentation pending, including uncertain expired dispatch', async t => {
  const item = await fixture(t);
  await item.bind();
  const index = await item.say('still owes context');
  const activity = `act/${index}`;
  const claim = { seat: item.bob, activity, kind: 'wake', at: 1, leaseMs: 1, claimToken: 'interrupted' };
  assert.equal((await item.artifact.claimDelivery(claim)).status, 'acquired');
  assert.equal(automaticWakeEligible(await item.evidence(index), Date.now()), false);
  assert.equal((await item.artifact.claimDelivery({ ...claim, at: 3, claimToken: 'later' })).evidence.outcome, 'unknown');
  const observer = await observeSessionPending(item.body, item.env);
  try { assert.equal((await observer.read())[0].notifications[0].actIndex, index); }
  finally { observer.close(); }
  const wake = { ...(await item.evidence(index))[0], outcome: 'failed' };
  assert.equal(automaticWakeEligible([wake], 10), true);
  assert.equal(automaticWakeEligible([{ ...wake, outcome: 'accepted' }], 10), false);
  const presentation = { ...wake, kind: 'presentation', outcome: 'dispatching', expiresAt: 11 };
  assert.equal(automaticWakeEligible([presentation], 10), false);
  assert.equal(automaticWakeEligible([presentation], 11), true);
  assert.equal(automaticWakeEligible([{ ...presentation, outcome: 'unknown' }], 12), false);
});

test('initial native acceptance is not receipt; exact prepared context confirms once and activity during send is not lost', async t => {
  const item = await fixture(t);
  await item.bind();
  const first = await item.say('first native attention');
  const calls = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  item.start(async input => {
    calls.push(input);
    const rows = await item.evidence(calls.length === 1 ? first : second);
    assert.equal(rows[0].outcome, 'dispatching');
    assert.equal(rows[0].correlation.token, input.id, 'correlation is durable before native I/O');
    if (calls.length === 1) await blocked;
    return accepted(input);
  });
  await until(() => calls.length === 1, 'initial pending activity did not reach native boundary');
  const second = await item.say('arrived during native send');
  release();
  await until(async () => (await item.evidence(second)).some(row => row.outcome === 'accepted'), 'activity during send was lost');
  assert.equal(calls.length, 2);
  assert.equal(await item.receipt(first), undefined);
  const context = (input, changes = {}) => ({ id: input.id, role: 'user', content: [{ type: 'text', text: input.text }], ...changes });
  const signal = new AbortController().signal;
  await observeOpenCodeContext(item.body.session, [context(calls[0], { id: 'wrong-token' }), context(calls[0], { role: 'assistant' }),
    context(calls[0], { content: [{ type: 'text', text: calls[0].text + 'changed' }] })], item.env, signal);
  assert.equal(await item.receipt(first), undefined);
  await observeOpenCodeContext(item.body.session, [context(calls[0])], item.env, signal);
  const received = await item.receipt(first);
  assert.ok(received);
  await observeOpenCodeContext(item.body.session, [context(calls[0])], item.env, signal);
  assert.deepEqual(await item.receipt(first), received);
  assert.equal(await item.receipt(second), undefined);
  await sleep(100);
  assert.equal(calls.length, 2, 'accepted wake cannot replay while waiting for context');
});

test('failed wake is retried on startup; unknown evidence settles without spin or replay on new conversation', async t => {
  const item = await fixture(t);
  await item.bind();
  const index = await item.say('failed before native receiver starts');
  const claim = { seat: item.bob, activity: `act/${index}`, kind: 'wake', at: Date.now(), leaseMs: 1000, claimToken: 'failed' };
  assert.equal((await item.artifact.claimDelivery(claim)).status, 'acquired');
  assert.equal(await item.artifact.completeDelivery({ ...claim, outcome: 'failed' }), true);
  const calls = [];
  item.start(async input => { calls.push(input); return {}; });
  await until(async () => (await item.evidence(index)).some(row => row.outcome === 'unknown'), 'failed activity was not retried');
  assert.deepEqual((await item.evidence(index)).map(row => row.outcome), ['failed', 'unknown']);
  let transactions = 0;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql, ...args) {
    if (/^BEGIN\b/.test(sql)) transactions++;
    return exec.call(this, sql, ...args);
  });
  await sleep(100);
  const settled = transactions;
  await sleep(150);
  assert.equal(transactions, settled, 'own claim/completion evidence must not repeatedly reproject');
  assert.equal(calls.length, 1);
  const later = await item.say('substantive new activity');
  await until(async () => (await item.evidence(later)).some(row => row.outcome === 'unknown'), 'new activity did not wake receiver');
  assert.equal(calls.length, 2, 'unknown wake must remain excluded on a substantive change');
  assert.equal(calls.filter(call => call.text.includes('failed before native receiver starts')).length, 1);
});

test('empty startup notices new membership; catch release and expiry wake pending; cancellation closes native wait and watchers', async t => {
  const item = await fixture(t);
  const calls = [];
  let opened = 0, closed = 0;
  const watch = fs.watch;
  t.mock.method(fs, 'watch', function(...args) {
    const watcher = watch.apply(this, args);
    opened++;
    const close = watcher.close.bind(watcher);
    watcher.close = () => { closed++; close(); };
    return watcher;
  });
  const lease = expiresAt => item.artifact.transactAs({ kind: 'participant', seat: item.bob }, facts =>
    facts.putLease('Bob', { leaseId: 'catch', heartbeatAt: Date.now(), expiresAt, filter: { mention: 'Bob' } }, item.bob.generation));
  await lease(Date.now() + 10_000);
  const index = await item.say('owned by catch');
  const receiver = item.start(async (input, { signal }) => {
    calls.push(input);
    if (calls.length < 3) return accepted(input);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await sleep(50);
  await item.bind();
  await sleep(100);
  assert.equal(calls.length, 0);
  await item.artifact.transactAs({ kind: 'participant', seat: item.bob }, facts => facts.removeLease('Bob', 'catch', item.bob.generation));
  await until(async () => (await item.evidence(index)).some(row => row.outcome === 'accepted'), 'lease removal did not wake delivery');
  await lease(Date.now() + 250);
  const expiry = await item.say('released by lease expiry');
  await until(async () => (await item.evidence(expiry)).some(row => row.outcome === 'accepted'), 'expiry alone did not wake delivery');
  assert.equal(calls.length, 2);
  const pending = await item.say('cancel native waiting');
  await until(() => calls.length === 3, 'native send not entered');
  receiver.abort.abort();
  await receiver.running;
  assert.ok(opened > 0);
  assert.equal(closed, opened, 'receiver shutdown must release all shared watcher subscriptions');
  assert.equal(await item.receipt(pending), undefined);
  await item.say('after receiver shutdown');
  await sleep(100);
  assert.equal(calls.length, 3);
});


test('receipt and takeover during native I/O exclude stale batch/context while new exact-body membership is discovered', async t => {
  const item = await fixture(t);
  await item.bind();
  const first = await item.say('in flight before takeover');
  const caught = await item.say('caught while first send waits');
  const calls = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  item.start(async input => {
    calls.push(input);
    if (calls.length === 1) await blocked;
    return accepted(input);
  });
  await until(() => calls.length === 1, 'first native I/O was not entered');
  await item.artifact.transactAs({ kind: 'participant', seat: item.bob }, facts => facts.markSeen('Bob', [caught], Date.now()));
  await item.artifact.transactAs({ kind: 'takeover', participant: 'Bob', body: { ...item.body, agent: 'other-agent' },
    expectedGeneration: item.bob.generation, wakeAddress: { kind: 'opencode-server', address: { sessionId: item.body.session } } }, facts => {
    facts.land({ kind: 'done', actor: 'Bob', at: Date.now() });
    facts.land({ kind: 'join', actor: 'Bob', at: Date.now() });
  });
  await item.say('belongs only to replacement agent');
  await item.artifact.transactAs({ kind: 'join', participant: 'Cara', body: item.body,
    wakeAddress: { kind: 'opencode-server', address: { sessionId: item.body.session } } }, facts =>
    facts.land({ kind: 'join', actor: 'Cara', at: Date.now() }));
  const fresh = (await item.artifact.transactAs({ kind: 'participant', seat: item.alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'new exact-body member', mentions: ['Cara', 'Bob'] }))).value.index;
  release();
  await until(async () => (await item.artifact.read(facts =>
    facts.deliveryEvidence('Cara', facts.seat('Cara').generation, `act/${fresh}`))).value.some(row => row.outcome === 'accepted'),
  'new exact-body membership did not receive pending activity');
  const newMessageCalls = calls.filter(call => call.text.includes('new exact-body member'));
  assert.equal(newMessageCalls.length, 2, 'both current seats with the exact native address receive the new activity');
  assert.deepEqual(newMessageCalls.map(call => call.text.match(/<square-activity[^>]* as="([^"]+)"/)?.[1]).sort(), ['Bob', 'Cara']);
  assert.match(calls[1].text, /new exact-body member/);
  await observeOpenCodeContext(item.body.session, [{ id: calls[0].id, role: 'user', content: [{ type: 'text', text: calls[0].text }] }],
    item.env, new AbortController().signal);
  assert.equal(await item.receipt(first), undefined, 'old prepared context cannot consume under a new generation');
  assert.ok(await item.receipt(caught));
  await sleep(100);
  assert.equal(calls.length, 3, 'the old in-flight attempt plus both exact-address deliveries remain accounted for');
});

test('an unreadable indexed candidate stays quiet and native delivery resumes after repair', async t => {
  const item = await fixture(t);
  await item.bind();
  const index = await item.say('repair restores native attention');
  const saved = fs.readFileSync(item.location);
  fs.writeFileSync(item.location, 'not a SQLite artifact');
  const calls = [];
  item.start(async input => { calls.push(input); return accepted(input); });
  await sleep(100);
  assert.equal(calls.length, 0, 'unreadable candidate cannot authorize native sending');
  fs.writeFileSync(item.location, saved);
  await until(async () => (await item.evidence(index)).some(row => row.outcome === 'accepted'), 'repair did not restore native delivery');
  assert.equal(calls.length, 1);
});
