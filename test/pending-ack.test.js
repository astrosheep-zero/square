import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Channel } from '../dist/channel.js';
import { Square } from '../dist/square-api.js';
import { parseActivityId } from '../dist/square-core.js';

const match = { fields: [{ path: ['job', 'id'], equals: 7 }] };
const ids = page => page.activities.map(activity => activity.id);

async function fixture(t, clock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pending-ack-'));
  const location = path.join(root, 'notices.square');
  const options = { path: location, wakeTransport: false, clock,
    env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') } };
  const channel = await Channel.create(options);
  const square = await Square.at(options);
  const endpoint = await channel.attach('Recipient', { owner: 'test:recipient' });
  const participant = await square.participant('Recipient', { owner: 'test:recipient' });
  t.after(async () => { await square.close(); await channel.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { channel, square, endpoint, participant, options };
}

test('pending filters addressed unconsumed metadata before paging and drains every page through ack', async t => {
  const { channel, square, endpoint, participant, options } = await fixture(t);
  await channel.attach('Other', { owner: 'test:other' });
  const send = (to, metadata, body = 'notice') => channel.send({ from: 'Coordinator', to, metadata, body });
  const unrelated = await send('Recipient', { job: { id: 8 } });
  await send('Other', { job: { id: 7 } });
  const expected = [];
  const fullBody = 'Full body ' + 'x'.repeat(400);
  for (let n = 0; n < 103; n++) expected.push((await send('Recipient', { job: { id: 7 }, n }, fullBody)).id);
  const lease = await endpoint.deferDelivery({ match, durationMs: 60_000 });
  const page = await endpoint.pending({ match });
  assert.deepEqual(ids(page), expected.slice(0, 100));
  assert.equal(page.remaining, 3);
  assert.equal(page.activities[0].body, fullBody, 'explicit pending reads full bodies, not delivery previews');
  assert.deepEqual(page.activities[0].metadata, { job: { id: 7 }, n: 0 });
  assert.equal(page.activities[0].perception, 'full');
  assert.equal(page.activities[0].via, 'mention');
  assert.deepEqual(await participant.pending({ match }), page, 'real Participant and Channel share the query');
  assert.deepEqual(ids(await endpoint.pending({ match, limit: 1 })), expected.slice(0, 1));
  assert.equal((await endpoint.pending({ match, limit: 1 })).remaining, 102);
  // Opening again sees the same page: neither querying nor a deferral consumes anything.
  const reopened = await Channel.open(options);
  try {
    assert.deepEqual(await (await reopened.endpoint('Recipient', { owner: 'test:recipient' })).pending({ match }), page);
  } finally { await reopened.close(); }
  assert.equal((await square.participants()).participants.find(p => p.name === 'Recipient').unreadActivityCount, 104);
  const drained = [];
  for (;;) {
    const next = await endpoint.pending({ match });
    if (!next.activities.length) break;
    drained.push(...ids(next));
    assert.deepEqual(await endpoint.ack(ids(next)), { consumed: next.activities.length });
  }
  assert.deepEqual(drained, expected);
  assert.deepEqual(ids(await participant.pending()), [unrelated.id]);
  assert.equal(await endpoint.releaseDeliveryDeferral(lease.id), true);
  assert.deepEqual(await endpoint.pending({ match }), { activities: [], remaining: 0 });
  assert.equal((await square.history({ limit: null })).activities.filter(a => a.kind === 'say').length, 105);
});

test('storage matching uses exact nested own-property scalar equalities and AND semantics', async t => {
  const { channel, endpoint } = await fixture(t);
  const metadata = JSON.parse('{"literal.key":{"quoted\\\"key":{"value":1,"flag":true,"nil":null,"nul\\u0000key":"ok"}},"list":[1],"__proto__":{"value":"own"}}');
  const sent = await channel.send({ from: 'Coordinator', to: 'Recipient', body: 'structured', metadata });
  const query = fields => endpoint.pending({ match: { fields }, limit: 1 });
  const field = (path, equals) => ({ path, equals });
  const value = field(['literal.key', 'quoted"key', 'value'], 1);
  const nil = field(['literal.key', 'quoted"key', 'nil'], null);
  assert.deepEqual(ids(await query([value, nil, field(['literal.key', 'quoted"key', 'flag'], true),
    field(['literal.key', 'quoted"key', 'nul\0key'], 'ok'), field(['__proto__', 'value'], 'own')])), [sent.id]);
  for (const wrong of [field(value.path, '1'), field(['literal.key', 'quoted"key', 'flag'], 1),
    field(['missing'], null), field(['list', '0'], 1), field(['toString'], null)]) {
    assert.deepEqual(await query([nil, wrong]), { activities: [], remaining: 0 });
  }
  await assert.rejects(endpoint.pending({ match: { fields: [] } }), error => error.code === 'invalid_args');
  await assert.rejects(endpoint.pending({ limit: 101 }), error => error.code === 'invalid_args');
  await assert.rejects(endpoint.pending({ limit: 0 }), error => error.code === 'invalid_args');
});

test('history and pending share exact IDs, unjoined senders, metadata, search and read-only cursor filters', async t => {
  const { channel, square, endpoint } = await fixture(t);
  await channel.attach('Other', { owner: 'test:other' });
  const send = (body, extra = {}) => channel.send({ from: 'keiyaku-notice', to: 'Recipient',
    body, metadata: { job: { id: 7 } }, ...extra });
  const older = await send('unrelated older body');
  const first = await send('Result [7] alpha'), second = await send('result [7] beta');
  const literalDistractor = await send('result 7 is not the literal bracketed text');
  await send('result [7] wrong metadata', { metadata: { job: { id: 8 } } });
  await send('result [7] wrong sender', { from: 'Coordinator' });
  const foreign = await send('result [7] other recipient', { to: 'Other' });
  const query = { from: ['KEIYAKU-NOTICE'], match, search: { text: 'result [7]', mode: 'literal' } };
  const oldest = await endpoint.pending({ ...query, limit: 1 });
  assert.deepEqual(ids(oldest), [first.id]);
  assert.equal(oldest.remaining, 1);
  const next = await endpoint.pending({ ...query, cursor: { id: first.id, direction: 'after' }, limit: 1 });
  assert.deepEqual(ids(next), [second.id]);
  assert.equal(next.remaining, 0);
  assert.deepEqual(ids(await endpoint.pending({ ...query, cursor: { id: second.id, direction: 'before' } })), [first.id]);
  assert.deepEqual(ids(await square.history({ ...query, mention: 'Recipient', limit: 1 })), [second.id], 'history keeps newest-page selection');
  assert.deepEqual(ids(await square.history({ ...query, mention: 'Recipient', cursor: { id: first.id, direction: 'after' }, limit: 1 })), [second.id]);
  assert.deepEqual(ids(await square.history({ ...query, limit: null })), [first.id, second.id, foreign.id], 'archive has no implicit recipient filter');
  for (const filter of [{ at: [] }, { from: [] }, { from: ['NeverJoined'] }]) {
    assert.deepEqual(ids(await square.history(filter)), []);
    assert.deepEqual(await endpoint.pending(filter), { activities: [], remaining: 0 });
  }
  const exact = { ...query, at: [foreign.id, second.id, first.id], search: { text: `^${first.id}$|^${second.id}$`, mode: 'regex' } };
  assert.deepEqual(ids(await square.history(exact)), [first.id, second.id]);
  assert.deepEqual(ids(await endpoint.pending(exact)), [first.id, second.id]);
  assert.deepEqual(ids(await endpoint.pending({ ...query, search: { text: '^keiyaku-notice$', mode: 'regex' } })),
    [older.id, first.id, second.id, literalDistractor.id]);
  assert.equal((await square.participants()).participants.some(p => p.name === 'keiyaku-notice'), false);
  assert.deepEqual(ids(await endpoint.pending(query)), [first.id, second.id], 'cursor reads never consume earlier pages');
});

test('shared query validation rejects malformed filters on both reads and search continuation counts only selected kinds', async t => {
  const { square, endpoint, participant } = await fixture(t);
  const sent = await participant.express('hello');
  const selected = await square.history({ search: { text: 'Recipient', mode: 'literal' }, limit: 1, observe: true });
  assert.deepEqual(ids(selected), [sent.activity.id]);
  assert.equal(selected.observation.totalMatches, 1);
  assert.equal(selected.observation.continuation, undefined, 'matching join is excluded by the search relation');
  for (const query of [
    { search: { text: '[', mode: 'regex' } },
    { search: { text: '', mode: 'literal' } },
    { cursor: { id: 'act/01', direction: 'after' } },
  ]) {
    for (const read of [input => square.history(input), input => endpoint.pending(input)])
      await assert.rejects(read(query), error => error.code === 'invalid_args');
  }
});

test('ack consumes exact addressed IDs atomically and idempotently without presentation evidence', async t => {
  let now = 1000;
  const { channel, square, endpoint, participant } = await fixture(t, () => now);
  const other = await channel.attach('Other', { owner: 'test:other' });
  const send = to => channel.send({ from: 'Coordinator', to, body: 'notice', metadata: { job: { id: 7 } } });
  const first = await send('Recipient'), second = await send(['Recipient', 'Other']), foreign = await send('Other');
  for (const unaddressed of [foreign.id, 'act/9999', endpoint.generation]) {
    await assert.rejects(endpoint.ack([first.id, unaddressed]), error => error.code === 'invalid_args' && error.facts.reason === 'not_addressed');
    assert.deepEqual(ids(await endpoint.pending()), [first.id, second.id]);
  }
  const abort = new AbortController();
  abort.abort(new Error('cancel explicit receipt'));
  await assert.rejects(endpoint.ack([first.id], { signal: abort.signal }), /cancel explicit receipt/);
  await assert.rejects(endpoint.pending({ match }, { signal: abort.signal }), /cancel explicit receipt/);
  await assert.rejects(endpoint.ack([first.id, 'not-an-id']), error => error.code === 'invalid_args');
  assert.deepEqual(await participant.ack([second.id, second.id]), { consumed: 1 });
  now = 2000;
  assert.deepEqual(await endpoint.ack([second.id]), { consumed: 0 });
  assert.deepEqual(await endpoint.ack([]), { consumed: 0 });
  assert.deepEqual(ids(await endpoint.pending()), [first.id], 'later acknowledgement never advances over an earlier hole');
  assert.deepEqual(ids(await other.pending()), [second.id, foreign.id], 'receipt belongs only to the addressed recipient');
  const evidence = (await square.artifact.read(facts => ({
    receipt: facts.receipt('Recipient', parseActivityId(second.id)),
    deliveries: facts.deliveryEvidence('Recipient', endpoint.generation),
    first: facts.receipt('Recipient', parseActivityId(first.id)),
  }))).value;
  assert.deepEqual(evidence, { receipt: { at: 1000 }, deliveries: [], first: undefined });
  assert.equal((await participant.catch({ id: second.id })).activities[0].id, second.id, 'exact catch remains repeatable after ack');
  assert.deepEqual(ids(await participant.catch()), [first.id], 'ordinary catch and ack share receipts');
  assert.deepEqual(await endpoint.pending(), { activities: [], remaining: 0 });
});

test('pending and even empty ack require the captured attached owner and generation', async t => {
  const { channel, endpoint } = await fixture(t);
  const sent = await channel.send({ from: 'Coordinator', to: 'Recipient', body: 'unconsumed across seat changes' });
  const assertFenced = async handle => {
    await assert.rejects(handle.pending({ match }), error => error.code === 'already_joined');
    await assert.rejects(handle.ack([]), error => error.code === 'already_joined');
    await assert.rejects(handle.ack([sent.id]), error => error.code === 'already_joined');
  };
  await channel.detach('Recipient', { owner: 'test:recipient', generation: endpoint.generation });
  await assertFenced(endpoint);
  const restored = await channel.reattach('Recipient', { owner: 'test:recipient' });
  assert.equal(restored.generation, endpoint.generation);
  assert.deepEqual(ids(await endpoint.pending()), [sent.id]);
  const foreign = await channel.attach('Recipient', { owner: 'test:foreign', takeover: true });
  await assertFenced(endpoint);
  const current = await channel.attach('Recipient', { owner: 'test:recipient', takeover: true });
  await assertFenced(endpoint);
  await assertFenced(foreign);
  assert.deepEqual(ids(await current.pending()), [sent.id], 'historical addressed receipt holes survive a new generation');
  assert.deepEqual(await current.ack([sent.id]), { consumed: 1 });
  await current.leave();
  await assertFenced(current);
});
