import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { flushSquarePosts } from '../dist/square-posting.js';

const DAY = 24 * 60 * 60 * 1000;
async function setup(t, route) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-export-recovery-'));
  const env = { ...process.env, SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'), SQUARE_NOW_MS: '1000', SQUARE_DISABLE_PASEO_WAKE: '1' };
  const square = await Square.build({ path: path.join(root, 'world.square'), markdown: '', env });
  const owner = `recipient:${root}`;
  const bob = (await square.join('Bob', { owner, ...(route ? { wakeAddress: route } : {}) })).participant;
  const artifact = createArtifactPort(await fs.realpath(square.location));
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY, clock: () => Date.now() });
  t.after(async () => { await artifact.close(); await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const session = await ledger.session(owner);
  return { root, env, square, bob, owner, artifact, ledger, session,
    cards: () => ledger.pending(owner, { generation: session.generation }),
    insert: body => artifact.transactAs({ kind: 'send', actor: 'notice' }, facts => facts.insertNotice({ from: 'notice', to: 'Bob', body }, 1000)),
  };
}
async function exporter(t, c, stage) {
  const child = fork(new URL('./fixtures/producer-export-crash.js', import.meta.url), [await fs.realpath(c.square.location), stage],
    { env: c.env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`Exporter exited early: ${stderr}`); })]);
  return async () => { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; };
}

test('later posting opportunities retry failed push without reinsertion or replay of accepted/unknown custody', async t => {
  let status = 503, calls = 0;
  const server = http.createServer((request, response) => {
    calls++; request.resume();
    response.writeHead(status); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const c = await setup(t, { kind: 'http', address: { url: `http://127.0.0.1:${server.address().port}/` } });
  const original = DeliveryLedger.prototype.post;
  let insertions = 0;
  t.mock.method(DeliveryLedger.prototype, 'post', function (input) { insertions++; return original.call(this, input); });
  await c.square.send({ from: 'notice', to: 'Bob', body: 'retry failed send' });
  const first = (await c.cards())[0];
  assert.equal(calls, 1);
  status = 204;
  await c.square.join('Bob', { owner: c.owner });
  assert.equal(calls, 2);
  assert.equal((await c.cards())[0].seq, first.seq);
  await c.square.join('Bob', { owner: c.owner });
  assert.equal(calls, 2, 'accepted custody is never automatically sent again');
  let uncertainCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { uncertainCalls++; throw new Error('lost acknowledgement'); });
  await c.square.send({ from: 'notice', to: 'Bob', body: 'uncertain send' });
  assert.equal(uncertainCalls, 1);
  await c.square.join('Bob', { owner: c.owner });
  assert.equal(uncertainCalls, 1, 'unknown custody is never automatically sent again');
  assert.equal(calls, 2, 'accepted custody is not retried while unrelated cards are posted');
  assert.equal(insertions, 2, 'dispatch retry does not call ledger.post again');
  assert.deepEqual((await c.ledger.handoffs(c.owner, { generation: c.session.generation })).map(attempt => attempt.outcome), ['failed', 'accepted', 'unknown']);
});

test('crash after producer settlement but before dispatch resumes an existing card on the next mutation', { timeout: 10000 }, async t => {
  let calls = 0;
  const server = http.createServer((request, response) => { calls++; request.resume(); response.writeHead(204); response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const c = await setup(t, { kind: 'http', address: { url: `http://127.0.0.1:${server.address().port}/` } });
  await c.insert('settled, no dispatch yet');
  const kill = await exporter(t, c, 'after-settle');
  const before = (await c.cards())[0];
  assert.equal(calls, 0);
  await kill();
  await c.square.join('Bob', { owner: c.owner });
  assert.equal(calls, 1);
  assert.equal((await c.cards())[0].seq, before.seq);
  assert.equal((await c.artifact.read(facts => facts.pendingPosts())).value.length, 0);
});

test('export ownership expires despite a live reused PID, preserves first export time and fences stale settlement', async t => {
  const c = await setup(t);
  await c.insert('bounded ownership');
  const post = (await c.artifact.read(facts => facts.pendingPosts()[0])).value;
  const first = Date.now();
  const acquire = (token, at) => c.artifact.transactAs({ kind: 'producer' }, facts => facts.acquirePost({ ...post, full: true }, token, process.pid, 1000, at)).then(result => result.value);
  assert.equal(await acquire('old-token', first), 'initial');
  assert.equal(await acquire('too-early', first + 59_999), false);
  assert.equal(await acquire('new-token', first + 60_000), 'recovered');
  assert.equal((await c.artifact.read(facts => facts.ownsPost('old-token', first + 60_000))).value, false);
  assert.equal((await c.artifact.settleAs({ kind: 'producer' }, facts => facts.settlePost('old-token', true, 'posted'))).value, false);
  assert.equal((await c.artifact.read(facts => facts.ownsPost('new-token', first + 60_000))).value, true);
  assert.equal(await acquire('outside-retention', first + 30 * DAY), false, 'recovery must not reset first possible export time');
  assert.equal((await c.artifact.read(facts => facts.ownsPost('new-token', first + 30 * DAY))).value, false);
  assert.equal(await acquire('backward-clock', first - 1), false);
});

test('crash uncertainty cannot resurrect a collected notification, and expired receipt proof leaves activity explicitly catchable', { timeout: 10000 }, async t => {
  const c = await setup(t);
  const alice = (await c.square.join('Alice', { owner: `alice:${c.root}` })).participant;
  const activity = (await alice.express('complete full card', { mentions: ['Bob'], force: true })).activity;
  await c.insert('already presented, then collected');
  const kill = await exporter(t, c, 'after-post');
  const claim = await c.ledger.claimPresentation(c.owner, { generation: c.session.generation, budgetChars: 10000 });
  assert.equal(claim.cards.length, 2);
  assert.equal(await claim.settle('presented'), true);
  assert.equal((await c.ledger.receipts(c.owner)).length, 2);
  await kill();
  const future = Date.now() + 31 * DAY;
  t.mock.method(Date, 'now', () => future);
  await c.ledger.post({ owner: c.owner, key: 'gc-trigger', text: 'unrelated card triggers bounded collection' });
  assert.equal((await c.ledger.receipts(c.owner)).length, 0);
  await c.square.join('Bob', { owner: c.owner });
  assert.deepEqual((await c.cards()).map(card => card.key), ['gc-trigger']);
  assert.deepEqual((await c.bob.pending()).activities.map(item => item.id), [activity.id], 'missing proof never fabricates consumption');
  assert.deepEqual((await c.bob.catch({ id: activity.id })).activities.map(item => item.id), [activity.id]);
  // Source time is deliberately ancient. A never-exported source has no admission TTL.
  await c.square.send({ from: 'notice', to: 'Bob', body: 'new source after retention', metadata: { kind: 'new' } });
  assert.ok((await c.cards()).some(card => card.text === 'new source after retention'));
});

for (const refusal of ['before-invocation', 'definite-refusal']) test(`known-unsent ${refusal} stays eligible beyond the uncertainty retention window`, async t => {
  const c = await setup(t), session = DeliveryLedger.prototype.session, post = DeliveryLedger.prototype.post;
  let sessions = 0, postCalls = 0;
  const finalCheck = t.mock.method(DeliveryLedger.prototype, 'session', async function (owner) {
    const current = await session.call(this, owner);
    sessions++;
    return refusal === 'before-invocation' && sessions === 3 ? { ...current, state: 'detached' } : current;
  });
  const insertion = t.mock.method(DeliveryLedger.prototype, 'post', async function (input) {
    postCalls++;
    return refusal === 'definite-refusal' && postCalls === 1 ? { status: 'unknown-session' } : post.call(this, input);
  });
  await c.square.send({ from: 'notice', to: 'Bob', body: 'known unsent' });
  assert.equal(postCalls, refusal === 'before-invocation' ? 0 : 1);
  assert.equal((await c.cards()).length, 0);
  assert.equal((await c.artifact.read(facts => facts.pendingPosts())).value.length, 1);
  finalCheck.mock.restore();
  const future = Date.now() + 31 * DAY;
  t.mock.method(Date, 'now', () => future);
  await c.square.join('Bob', { owner: c.owner });
  await c.square.join('Bob', { owner: c.owner });
  assert.equal(postCalls, refusal === 'before-invocation' ? 1 : 2);
  assert.deepEqual((await c.cards()).map(card => card.text), ['known unsent']);
  assert.equal((await c.artifact.read(facts => facts.pendingPosts())).value.length, 0);
  insertion.mock.restore();
});

test('an unsent recovery cannot erase an earlier uncertain insertion or resurrect it after collection', async t => {
  const c = await setup(t), originalPost = DeliveryLedger.prototype.post;
  let calls = 0;
  const insertion = t.mock.method(DeliveryLedger.prototype, 'post', async function (input) {
    calls++;
    await originalPost.call(this, input);
    throw Error('acknowledgement lost after possible insertion');
  });
  await c.square.send({ from: 'notice', to: 'Bob', body: 'uncertain before unsent recovery' });
  assert.equal(calls, 1);
  assert.equal((await c.cards()).length, 1);
  const originalSession = DeliveryLedger.prototype.session;
  let checks = 0;
  const finalCheck = t.mock.method(DeliveryLedger.prototype, 'session', async function (owner) {
    const current = await originalSession.call(this, owner);
    return ++checks === 2 ? { ...current, state: 'detached' } : current;
  });
  await flushSquarePosts(c.artifact, await fs.realpath(c.square.location), c.env, () => 1000);
  assert.ok(checks >= 2);
  assert.equal(calls, 1, 'recovered attempt aborted before invoking post');
  finalCheck.mock.restore();
  insertion.mock.restore();
  const claim = await c.ledger.claimPresentation(c.owner, { generation: c.session.generation, budgetChars: 1000 });
  assert.equal(await claim.settle('presented'), true);
  const future = Date.now() + 31 * DAY;
  t.mock.method(Date, 'now', () => future);
  await originalPost.call(c.ledger, { owner: c.owner, key: 'collect', text: 'collect retained evidence' });
  const count = t.mock.method(DeliveryLedger.prototype, 'post', async function (input) { calls++; return originalPost.call(this, input); });
  await c.square.join('Bob', { owner: c.owner });
  assert.equal(calls, 1, 'earlier uncertainty still blocks automatic reinsertion');
  assert.deepEqual((await c.cards()).map(card => card.key), ['collect']);
  assert.equal((await c.artifact.read(facts => facts.pendingPosts())).value.length, 1);
  count.mock.restore();
});

test('notice results, producer storage and posted cards preserve mixed newline bytes', async t => {
  const c = await setup(t);
  const body = '`answer`\nfirst\r\nsecond\r\n\n---\nreport\r\n';
  const result = await c.square.send({ from: 'notice', to: 'Bob', body });
  assert.equal(result.body, body);
  assert.equal((await c.artifact.read(facts => facts.postedPosts()[0])).value.body, body);
  assert.equal((await c.cards())[0].text, body);
});

test('done withdraws only its captured unclaimed cards without consuming history or recalling custody', async t => {
  const c = await setup(t);
  const alice = (await c.square.join('Alice', { owner: `alice:${c.root}` })).participant;
  const carol = (await c.square.join('Carol', { owner: c.owner })).participant;
  const first = (await alice.express('unclaimed for both', { mentions: ['Bob', 'Carol'], force: true })).activity;
  const second = (await alice.express('held for Bob', { mentions: ['Bob'], force: true })).activity;
  const cards = await c.cards();
  const held = cards.find(card => card.key.includes(`#${second.id}/recipient/bob/`));
  await c.ledger.updateRoutes({ owner: c.owner, generation: c.session.generation, routes: [{ kind: 'test-held', address: {} }] });
  await c.ledger.dispatchHandoff(c.owner, held.key, { kind: 'test-held', send: async () => 'unknown' }, { generation: c.session.generation, timeoutMs: 1000 });
  await c.bob.done();
  const pending = await c.cards();
  assert.equal(pending.some(card => card.key.includes(`#${first.id}/recipient/bob/`)), false);
  assert.ok(pending.some(card => card.key.includes(`/recipient/carol/`)), 'another seat under the same owner is not withdrawn');
  assert.ok(pending.some(card => card.key === held.key), 'held custody cannot be recalled');
  assert.equal((await c.artifact.read(facts => facts.receipt('Bob', Number(first.id.slice(4))))).value, undefined);
  const reborn = (await c.square.join('Bob', { owner: c.owner })).participant;
  await alice.express('replacement generation', { mentions: ['Bob'], force: true });
  assert.ok((await c.cards()).some(card => card.text.includes('replacement generation')));
  assert.deepEqual((await carol.pending()).activities.map(item => item.id), [first.id]);
  assert.notEqual(reborn.generation, c.bob.generation);
});
