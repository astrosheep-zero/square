import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { WATCH_STALE_MS } from '../dist/runtime.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-perceive-export-'));
  Object.assign(process.env, { SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'), SQUARE_DISABLE_PASEO_WAKE: '1' });
  let now = Date.now();
  const clock = () => now;
  const square = await Square.build({ path: path.join(root, 'world.square'), markdown: '', clock });
  const alice = (await square.join('Alice', { owner: 'perceive:alice' })).participant;
  const carol = (await square.join('Carol', { owner: 'perceive:carol' })).participant;
  const bob = (await square.join('Bob', { owner: 'perceive:bob' })).participant;
  const ledger = await DeliveryLedger.open();
  const artifact = createArtifactPort(square.location);
  const session = await ledger.session('perceive:bob');
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await artifact.close(); await square.close(); await ledger.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, clock, square, alice, carol, bob, artifact, cleanups,
    advance: ms => { now += ms; },
    cards: () => ledger.pending(session.owner, { generation: session.generation }),
  };
}
async function armPerceive(c, options = { from: ['Alice'] }) {
  const waiter = await Square.at({ path: c.square.location, clock: c.clock });
  const originalRevision = waiter.artifact.revision.bind(waiter.artifact), parked = deferred(), resume = deferred(), started = deferred();
  let pause = true;
  // Pause only consumer scheduling after its real lease commit, before its first selection.
  waiter.artifact.revision = async signal => {
    if (pause) { pause = false; parked.resolve(); await resume.promise; }
    return originalRevision(signal);
  };
  const bob = await waiter.participant('Bob', { owner: 'perceive:bob' });
  const abort = new AbortController();
  const result = bob.perceive({ idle: 10_000, ...options }, { signal: abort.signal,
    onProgress: progress => { if (progress.kind === 'perceive-started') started.resolve(); },
  });
  // Cleanup may cancel a still-running perceive; observe its rejection from the start.
  void result.catch(() => undefined);
  c.cleanups.push(async () => {
    abort.abort(); resume.resolve(); await result.catch(() => undefined);
    await waiter.close();
  });
  await started.promise; await parked.promise;
  return { result, resume: resume.resolve, abort: () => { abort.abort(); resume.resolve(); } };
}
const hasCard = (cards, id) => cards.some(card => card.key.includes(`#${id}/`));

test('a live filtered perceive owns matching exports while excluded routes and notices remain eligible', { timeout: 10000 }, async t => {
  const c = await fixture(t);
  await c.bob.listen('Alice');
  const waiting = await armPerceive(c, { from: ['Alice'], mention: true });
  const matched = (await c.alice.express({ body: 'owned by perceive', mentions: ['Bob'], force: true })).activity;
  assert.equal(hasCard(await c.cards(), matched.id), false);
  assert.equal((await c.artifact.read(facts => facts.postedPosts().some(post => post.kind === 'activity' && post.index === Number(matched.id.slice(4))))).value, false, 'matching source has no export claim');
  const excluded = (await c.carol.express({ body: 'excluded sender', mentions: ['Bob'], force: true })).activity;
  const listener = (await c.alice.express({ body: 'listener route outside attention filter', force: true })).activity;
  await c.square.send({ from: 'Alice', to: 'Bob', body: 'raw direct notice', metadata: { kind: 'notice' } });
  const before = await c.cards();
  assert.equal(hasCard(before, matched.id), false);
  assert.equal(hasCard(before, excluded.id), true);
  assert.equal(hasCard(before, listener.id), true);
  assert.ok(before.some(card => card.text === 'raw direct notice'));
  waiting.resume();
  assert.deepEqual((await waiting.result).activities.map(activity => activity.id), [matched.id]);
  await c.square.join('Bob', { owner: 'perceive:bob' });
  assert.equal(hasCard(await c.cards(), matched.id), false, 'consumption prevents export after perceive release');
  assert.deepEqual((await c.bob.pending()).activities.map(activity => activity.id), [excluded.id, listener.id]);
});

for (const ending of ['release', 'expiry']) test(`perceive ${ending} permits unconsumed activity at the next ordinary posting opportunity`, { timeout: 10000 }, async t => {
  const c = await fixture(t), waiting = await armPerceive(c);
  const activity = (await c.alice.express({ body: `unconsumed after ${ending}`, mentions: ['Bob'], force: true })).activity;
  assert.equal(hasCard(await c.cards(), activity.id), false);
  if (ending === 'release') {
    waiting.abort();
    await assert.rejects(waiting.result, error => error.name === 'AbortError' || error.code === 'cancelled');
  } else {
    c.advance(WATCH_STALE_MS + 1);
  }
  assert.equal(hasCard(await c.cards(), activity.id), false, 'release or time passing does not invent a scheduler');
  await c.square.join('Bob', { owner: 'perceive:bob' });
  await c.square.join('Bob', { owner: 'perceive:bob' });
  assert.equal((await c.cards()).filter(card => card.key.includes(`#${activity.id}/`)).length, 1);
  assert.deepEqual((await c.bob.pending()).activities.map(item => item.id), [activity.id]);
});

test('a later perceive does not recall committed export ownership', { timeout: 10000 }, async t => {
  const c = await fixture(t), entered = deferred(), resumePost = deferred();
  const original = DeliveryLedger.prototype.post;
  t.mock.method(DeliveryLedger.prototype, 'post', async function (input) {
    if (input.text.includes('ownership already committed')) { entered.resolve(); await resumePost.promise; }
    return original.call(this, input);
  });
  let waiting;
  const sending = c.alice.express({ body: 'ownership already committed', mentions: ['Bob'], force: true });
  try {
    await entered.promise;
    waiting = await armPerceive(c);
    resumePost.resolve();
    const activity = (await sending).activity;
    assert.equal(hasCard(await c.cards(), activity.id), true);
    waiting.resume();
    assert.deepEqual((await waiting.result).activities.map(item => item.id), [activity.id]);
  } finally { resumePost.resolve(); await sending; }
});
