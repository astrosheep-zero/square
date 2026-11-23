import { encodeDeliveryKey } from '../dist/core/delivery-key.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createProducerDriver } from '../dist/artifact/square-producer-store.js';
import { Square } from '../dist/api/square-api.js';
import { createArtifactPort } from '../dist/artifact/artifact.js';
import { DeliveryLedger } from '../dist/ledger/delivery-ledger.js';
import { parseSquarePostKey, squarePostKey } from '../dist/core/delivery-key.js';

test('in-memory producer keys round-trip, fold exact receipts and withdraw only the current card', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-memory-keys-'));
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  const square = Square.inMemory({ ledgerLocation, markdown: '' });
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  t.after(async () => { await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: 'memory:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'memory:bob' })).participant;
  const session = await ledger.session('memory:bob');
  await alice.express('short in-memory activity', { mentions: ['Bob'], force: true });
  const claim = await ledger.claimPresentation('memory:bob', { generation: session.generation, budgetChars: 10000 });
  assert.equal(claim.cards.length, 1);
  const key = claim.cards[0].key;
  assert.equal(key[1], square.location);
  assert.match(square.location, /^memory:\/\//);
  assert.deepEqual(parseSquarePostKey(square.location, key), { kind: 'activity', index: Number(key[7]), recipientKey: 'bob', generation: bob.generation });
  await claim.settle('presented');
  await square.join('Alice', { owner: 'memory:alice' });
  assert.deepEqual((await bob.pending()).activities, [], 'normal mutation folds the in-memory full receipt');
  const next = await alice.express('withdraw this in-memory card', { mentions: ['Bob'], force: true });
  assert.equal((await ledger.cards({ owner: 'memory:bob', keyPrefix: ['square', square.location] })).length, 1);
  await bob.perceive({ ids: [next.activity.id] });
  assert.deepEqual(await ledger.cards({ owner: 'memory:bob', keyPrefix: ['square', square.location] }), []);
  assert.deepEqual((await ledger.receipts('memory:bob')).map(r => r.key), [key], 'withdrawal does not invent presentation evidence');
});

test('producer selection does not issue a query per historical recipient, and exact receipts stay scoped', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-post-selection-'));
  const square = await Square.build({ path: path.join(root, 'world.square'), ledgerLocation: path.join(root, 'ledger.sqlite'), markdown: '' });
  await square.join('Alice', { owner: 'selection:alice' });
  await square.join('Bob', { owner: 'selection:bob' });
  const artifact = createArtifactPort(square.location);
  const db = new DatabaseSync(square.location);
  t.after(async () => { db.close(); await artifact.close(); await square.close(); await fs.rm(root, { recursive: true, force: true }); });
  const seat = (await artifact.read(facts => facts.seat('Alice'))).value;
  const add = count => artifact.transactAs({ kind: 'participant', seat }, facts => {
    for (let i = 0; i < count; i++) facts.land({ kind: 'say', actor: 'Alice', at: i, body: 'pending body', metadata: { outcome: 'pending' }, mentions: ['Bob'] });
  });
  const measure = operation => {
    const prepare = db.prepare.bind(db);
    const calls = t.mock.method(db, 'prepare', (...args) => prepare(...args));
    try { const result = operation(createProducerDriver(db)); return { result, queries: calls.mock.callCount() }; }
    finally { calls.mock.restore(); }
  };
  await add(1);
  const first = measure(driver => driver.pendingPosts());
  await add(127);
  const many = measure(driver => driver.pendingPosts());
  assert.equal(many.result.length, 128);
  assert.equal(many.queries, first.queries, 'history growth must not add per-recipient queries');
  const post = { ...many.result[0], full: true };
  const driver = createProducerDriver(db);
  assert.equal(driver.acquirePost(post, 'selection-token', process.pid, Date.now()), 'initial');
  assert.equal(driver.settlePost('selection-token', true, 'posted'), true);
  assert.equal(driver.foldReceipt({ ...post, generation: 'stale' }, Date.now()), false);
  assert.equal(driver.foldReceipt(post, Date.now()), true);
  assert.equal(driver.foldReceipt(post, Date.now()), false);
  assert.equal(driver.pendingPosts().length, 127);
  assert.deepEqual(driver.postsAt([parseSquarePostKey(square.location, squarePostKey(square.location, post))])
    .map(item => [item.index, item.consumed]), [[post.index, true]]);

  await artifact.transactAs({ kind: 'send', actor: 'notice' }, facts => {
    for (let i = 0; i < 3; i++) facts.insertNotice({ from: 'notice', to: 'Bob', body: `notice-${i}`, metadata: { outcome: 'notice' } }, Date.now());
  });
  const activities = [post, ...many.result.slice(1, 3)];
  const notices = driver.pendingPosts().filter(item => item.kind === 'notice');
  for (const group of [activities, notices]) {
    for (const [i, item] of group.entries()) {
      if (item === post) continue;
      const token = `${item.kind}-${item.index}`, full = i !== 2;
      assert.equal(driver.acquirePost({ ...item, full }, token, process.pid, Date.now()), 'initial');
      driver.settlePost(token, full, 'posted');
      if (i === 0) assert.equal(driver.foldReceipt(item, Date.now()), true);
    }
  }
  const selected = [...activities, ...notices];
  const ids = selected.map(item => parseSquarePostKey(square.location, squarePostKey(square.location, item)));
  const ordinary = driver.postsAt(ids);
  assert.equal(ordinary.length, 6, 'ordinary exact reads retain consumed and truncated records');
  assert.ok(ordinary.every(item => item.body && item.metadata && item.from && Number.isFinite(item.at)), 'full callers retain card content');
  const disposition = ({ kind, index, recipient, owner, generation, consumed }) => ({ kind, index, recipient, owner, generation, consumed });
  const expected = ordinary.map(disposition);
  assert.deepEqual(driver.postDispositionsAt(ids), expected);
  assert.deepEqual(driver.postDispositionsAt([]), []);
  assert.deepEqual(driver.postsAt(ids, 'receipt'), ordinary.filter(item => !item.consumed && item.full));
  const stale = ids.map(id => ({ ...id, generation: 'stale' }));
  assert.deepEqual(driver.postsAt(stale, 'receipt'), []);
  assert.deepEqual(driver.postDispositionsAt(stale), []);
  // Excluded content cannot even be decoded by receipt selection.
  for (const i of [0, 2]) {
    db.prepare("UPDATE activities SET payload_json='null' WHERE act_index=?").run(activities[i].index);
    db.prepare("UPDATE square_notices SET body_json='null' WHERE notice_index=?").run(notices[i].index);
  }
  assert.deepEqual(driver.postsAt(ids, 'receipt').map(item => [item.kind, item.index]),
    [['activity', activities[1].index], ['notice', notices[1].index]]);
  for (const item of selected) {
    if (item.kind === 'activity') db.prepare("UPDATE activities SET payload_json='null' WHERE act_index=?").run(item.index);
    else db.prepare("UPDATE square_notices SET body_json='null',metadata_json='not-json' WHERE notice_index=?").run(item.index);
  }
  assert.deepEqual(driver.postDispositionsAt(ids), expected, 'withdrawal never decodes body or metadata, including live full cards');
});

for (const stage of ['before-post', 'after-post']) test(`producer recovery preserves ownership and idempotence at ${stage}`, { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-post-crash-'));
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  const square = await Square.build({ path: path.join(root, 'world.square'), ledgerLocation, markdown: '' });
  const owner = `crash:${root}`;
  await square.join('recipient', { owner });
  const location = await fs.realpath(square.location);
  const artifact = createArtifactPort(location);
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  let child;
  t.after(async () => { child?.kill('SIGKILL'); await artifact.close(); await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  await artifact.transactAs({ kind: 'send', actor: 'notice' }, facts => facts.insertNotice({ from: 'notice', to: 'recipient', body: 'one durable card' }, Date.now()));
  child = fork(new URL('./fixtures/producer-export-crash.js', import.meta.url), [location, stage, ledgerLocation], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errorText = '';
  child.stderr.on('data', value => { errorText += value; });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`Exporter exited before ownership: ${errorText}`); })]);
  const generation = (await ledger.session(owner)).generation;
  await square.join('recipient', { owner });
  assert.equal((await ledger.pending(owner, { generation })).length, stage === 'before-post' ? 0 : 1, 'a live captured exporter is never stolen');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  child = undefined;
  await square.join('recipient', { owner });
  await square.join('recipient', { owner });
  assert.deepEqual((await ledger.pending(owner, { generation })).map(card => card.text), ['one durable card']);
  const posted = (await artifact.read(facts => facts.postsAt([parseSquarePostKey(location, squarePostKey(location,
    { kind: 'notice', index: 0, recipient: 'recipient', generation: facts.seat('recipient').generation }))]))).value;
  assert.equal(posted.length, 1);
  assert.equal(posted[0].full, true);
});

test('a metadata-only card receipt leaves the structured activity unread until explicit perceive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-structured-card-'));
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  const square = await Square.build({ path: path.join(root, 'world.square'), ledgerLocation, markdown: '' });
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  t.after(async () => { await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: `a:${root}` })).participant;
  const bob = (await square.join('Bob', { owner: `b:${root}` })).participant;
  const sent = await alice.express({ metadata: { payload: { outcome: 'hidden structured data' } }, mentions: ['Bob'] });
  const session = await ledger.session(`b:${root}`);
  const claim = await ledger.claimPresentation(session.owner, { generation: session.generation, budgetChars: 4000 });
  assert.match(claim.cards[0].text, /structured activity/);
  assert.match(claim.cards[0].text, new RegExp(`history .*${sent.activity.id}`));
  assert.doesNotMatch(claim.cards[0].text, /hidden structured data/);
  assert.equal(await claim.settle('presented'), true);
  await square.join('Alice', { owner: `a:${root}` });
  assert.deepEqual((await bob.pending()).activities.map(activity => activity.id), [sent.activity.id]);
  const perceived = await bob.perceive({ ids: [sent.activity.id] });
  assert.deepEqual(perceived.activities[0].metadata, { payload: { outcome: 'hidden structured data' } });
  assert.equal((await bob.pending()).activities.length, 0);
});

test('two recipient seats of one host owner keep distinct cards and independent read state across attachment rotation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-multiseat-card-'));
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  const square = await Square.build({ path: path.join(root, 'world.square'), ledgerLocation, markdown: '' });
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  t.after(async () => { await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: `a:${root}` })).participant;
  const shared = `shared:${root}`;
  const bob = (await square.join('Bob', { owner: shared })).participant;
  const carol = (await square.join('Carol', { owner: shared })).participant;
  const sent = await alice.express({ body: 'one activity, two seats', mentions: ['Bob', 'Carol'] });
  const before = await ledger.session(shared);
  const cards = await ledger.pending(shared, { generation: before.generation });
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map(card => encodeDeliveryKey(card.key))).size, 2);
  assert.match(cards[0].text, /as="Bob"/);
  assert.match(cards[1].text, /as="Carol"/);
  const claim = await ledger.claimPresentation(shared, { generation: before.generation, budgetChars: 1 });
  assert.equal(claim.cards.length, 1);
  assert.equal(await claim.settle('presented'), true);
  const rotated = await ledger.attach({ owner: shared, expectedGeneration: before.generation, routes: before.routes });
  assert.notEqual(rotated.generation, before.generation);
  await square.join('Alice', { owner: `a:${root}` });
  assert.equal((await bob.pending()).activities.length, 0);
  assert.deepEqual((await carol.pending()).activities.map(activity => activity.id), [sent.activity.id]);
  assert.deepEqual((await ledger.pending(shared, { generation: rotated.generation })).map(card => card.key), [cards[1].key]);
});
