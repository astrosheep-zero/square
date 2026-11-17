import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateSquare, Square } from '../dist/index.js';
import { migrateSquare as apiMigrate } from '../dist/square-api.js';
import { createArtifactPort, createSquareFile } from '../dist/artifact.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { flushSquarePosts, reconcileSquareDelivery } from '../dist/square-posting.js';
import { squarePostKey } from '../dist/square-post.js';
import { seedFormat12 } from './fixtures/format12.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'old #? [名].square'), ledgerLocation: path.join(root, 'delivery.sqlite') };
}
function read(file, select) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return select(db); } finally { db.close(); }
}
function change(file, sql) {
  const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); }
}
function snapshot(file) {
  return read(file, db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    schema: db.prepare("SELECT * FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all(),
    tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY ${db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.cid + 1).join(',')}`).all()])),
  }));
}

test('explicit migration preserves every old logical cell, identity and claim, and backfills only captured noncurrent tuples', async t => {
  const { file, root } = setup(t); seedFormat12(file);
  const before = snapshot(file), inode = fs.statSync(file).ino;
  const open = t.mock.method(DeliveryLedger, 'open', () => { throw Error('migration must never open the ledger'); });
  assert.equal(migrateSquare, apiMigrate);
  await assert.rejects(Square.at({ path: file }), /opens only fresh format-13/);
  assert.deepEqual(await migrateSquare({ cwd: root, path: path.basename(file) }), { location: file, fromVersion: 12, toVersion: 13, changed: true });
  const after = snapshot(file);
  assert.equal(fs.statSync(file).ino, inode, 'the same single file is upgraded');
  assert.equal(after.version, 13);
  assert.equal(Object.keys(before.tables).length, 13);
  for (const [name, rows] of Object.entries(before.tables)) assert.deepEqual(after.tables[name], rows, name);
  assert.deepEqual(after.schema.filter(row => before.schema.some(old => old.name === row.name)), before.schema);
  assert.deepEqual(after.tables.producer_receipt_watermarks, []);
  const tuples = after.tables.producer_departures.map(r => [JSON.parse(r.participant_json), JSON.parse(r.owner_json), JSON.parse(r.generation_json)]);
  assert.deepEqual(tuples.sort(), [
    ['Bob', 'owner-old-b', 'b-old'], ['Bob', 'owner-b', 'b-previous'], ['Bob', 'owner-old-b', 'b-new'],
    ['Gone', 'owner-gone', 'g-old'], ['Gone', 'notice-only-owner', 'notice-only-gen'], ['Gone', 'owner-gone', 'g-survivor'],
  ].sort());
  assert.equal(new Set(after.tables.producer_departures.map(r => r.token)).size, tuples.length);
  after.tables.producer_departures.forEach(r => assert.match(r.token, /^[0-9a-f-]{36}$/));
  const bytes = fs.readFileSync(file);
  assert.deepEqual(await migrateSquare({ path: file }), { location: file, fromVersion: 13, toVersion: 13, changed: false });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(open.mock.callCount(), 0);
  const square = await Square.at({ path: file });
  try {
    assert.ok((await square.history({ limit: 100 })).activities.some(a => a.id === 'act/4' && a.body === 'old captured audience\r\nbytes'));
    assert.ok((await (await square.participant('Bob', { owner: 'owner-b' })).pending()).activities.some(a => a.id === 'act/7'));
  } finally { await square.close(); }
});

test('existing13 producer reconciliation suppresses migrated old work, recovers a preserved current claim and replays compatible receipts from zero', async t => {
  const { file, ledgerLocation } = setup(t); seedFormat12(file); await migrateSquare({ path: file });
  const artifact = createArtifactPort(file), ledger = await DeliveryLedger.open({ location: ledgerLocation });
  t.after(async () => { await artifact.close(); await ledger.close(); });
  const posts = (await artifact.read(f => f.postsAt([
    { kind: 'activity', index: 4 }, { kind: 'activity', index: 7 }, { kind: 'activity', index: 11 }, { kind: 'notice', index: 2 },
  ]))).value;
  for (const owner of new Set(posts.map(p => p.owner))) await ledger.attach({ owner, expectedGeneration: null, routes: [] });
  const oldActivity = posts.find(p => p.index === 4 && p.recipient === 'Bob');
  const oldNotice = posts.find(p => p.kind === 'notice');
  const current = posts.find(p => p.index === 7);
  for (const post of [oldActivity, oldNotice, current]) await ledger.post({ owner: post.owner, key: squarePostKey(file, post), text: post.body });
  const session = await ledger.session(current.owner);
  const claim = await ledger.claimPresentation(current.owner, { generation: session.generation, budgetChars: 10000 });
  assert.equal(await claim.settle('presented'), true);
  assert.equal((await artifact.read(f => f.receiptWatermark(current.owner))).value, 0);
  await reconcileSquareDelivery(artifact, file, () => 3000, undefined, ledgerLocation);
  for (const post of [oldActivity, oldNotice]) {
    assert.deepEqual(await ledger.pending(post.owner, { generation: (await ledger.session(post.owner)).generation }), []);
    assert.equal((await ledger.post({ owner: post.owner, key: squarePostKey(file, post), text: post.body })).status, 'suppressed');
  }
  assert.ok((await artifact.read(f => f.receipt('Bob', 7))).value, 'compatible full-card receipt is replayed');
  assert.ok((await artifact.read(f => f.receiptWatermark(current.owner))).value > 0);
  assert.deepEqual((await artifact.read(f => f.departedSeats())).value, []);
  await flushSquarePosts(artifact, file, () => 3001, undefined, ledgerLocation);
  const recovered = posts.find(p => p.index === 11);
  const pending = await ledger.pending(recovered.owner, { generation: session.generation });
  assert.ok(pending.some(c => c.key === squarePostKey(file, recovered)), 'preserved stale claim recovers under normal13 semantics');
  const row = read(file, db => db.prepare("SELECT * FROM square_posts WHERE kind='activity' AND item_index=11").get());
  assert.equal(row.posted, 1); assert.equal(row.token, null);
  assert.ok(row.first_export_at < Date.now() - 60000, 'recovery keeps original export age');
});

test('readonly preflight rejects unsupported identity, framing and malformed producer facts without changing bytes', async t => {
  const { root } = setup(t);
  const corruptions = [
    'PRAGMA user_version=11', 'PRAGMA application_id=42', 'CREATE TABLE extra(x)',
    'DROP INDEX activity_kind_index; CREATE INDEX activity_kind_index ON activities(at)',
    "UPDATE activities SET payload_json='{}' WHERE act_index=4",
    "UPDATE square_notices SET metadata_json='[]' WHERE notice_index=0",
    "UPDATE notice_audience SET owner_json='null' WHERE notice_index=0",
    "UPDATE producer_consumption SET match_json='{}'",
    'UPDATE square_posts SET owner_pid=0 WHERE token IS NOT NULL',
    "UPDATE catch_leases SET lease_json='{}'", 'PRAGMA journal_mode=WAL',
  ];
  for (const [index, sql] of corruptions.entries()) {
    const file = seedFormat12(path.join(root, `bad-${index}.square`)); change(file, sql);
    const before = fs.readFileSync(file), stat = fs.statSync(file);
    await assert.rejects(migrateSquare({ path: file }), undefined, sql);
    assert.deepEqual(fs.readFileSync(file), before, sql);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs, sql);
  }
  const spoof = path.join(root, 'spoof.square');
  change(spoof, 'PRAGMA application_id=1397838405; PRAGMA user_version=12; CREATE TABLE square_meta(id)');
  const before = fs.readFileSync(spoof);
  await assert.rejects(migrateSquare({ path: spoof }), /schema/); assert.deepEqual(fs.readFileSync(spoof), before);
  const missing = path.join(root, 'absent.square');
  await assert.rejects(migrateSquare({ path: missing }), /not found/); assert.equal(fs.existsSync(missing), false);
  await assert.rejects(migrateSquare({ path: path.join(root, 'wrong.sqlite') }), /extension/);
});

test('Format13 no-op is fully validated and never opens a writable connection', async t => {
  const { file } = setup(t); seedFormat12(file); await migrateSquare({ path: file });
  const exec = DatabaseSync.prototype.exec;
  const writable = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    assert.doesNotMatch(sql, /BEGIN EXCLUSIVE|CREATE TABLE|synchronous=FULL|user_version=/);
    return exec.call(this, sql);
  });
  await migrateSquare({ path: file });
  writable.mock.restore();
  // Empty departure tokens pass SQLite integrity/schema checks but cannot serve cleanup.
  change(file, "UPDATE producer_departures SET token=''");
  const bytes = fs.readFileSync(file);
  await assert.rejects(migrateSquare({ path: file }), /malformed/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('actual SQLite FULL during table creation rolls back schema/version/data, then a retry succeeds', async t => {
  const { file } = setup(t); seedFormat12(file);
  const before = snapshot(file), bytes = fs.readFileSync(file), exec = DatabaseSync.prototype.exec;
  let faulted = false;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql.startsWith('CREATE TABLE producer_receipt_watermarks')) {
      faulted = true;
      const pages = this.prepare('PRAGMA page_count').get().page_count;
      exec.call(this, `PRAGMA max_page_count=${pages + 1}`);
    }
    return exec.call(this, sql);
  });
  await assert.rejects(migrateSquare({ path: file }), e => e.errcode === 13 && /full/i.test(e.message));
  fault.mock.restore();
  assert.equal(faulted, true);
  assert.deepEqual(snapshot(file), before);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal((await migrateSquare({ path: file })).changed, true);
});

test('exclusive revalidation rejects a source changed after readonly preflight, and queued cancellation leaves12 intact', async t => {
  const { file } = setup(t); seedFormat12(file);
  const close = DatabaseSync.prototype.close;
  let competingBytes;
  const race = t.mock.method(DatabaseSync.prototype, 'close', function () {
    close.call(this);
    if (competingBytes !== undefined) return;
    competingBytes = null;
    change(file, "UPDATE producer_consumption SET match_json='{}'");
    competingBytes = fs.readFileSync(file);
  });
  await assert.rejects(migrateSquare({ path: file }), /match|fields/i);
  race.mock.restore();
  assert.deepEqual(fs.readFileSync(file), competingBytes);
  change(file, 'DELETE FROM producer_consumption');
  const before = snapshot(file), blocker = new DatabaseSync(file);
  blocker.exec('BEGIN IMMEDIATE');
  const controller = new AbortController(), reason = Error('cancel waiting migration');
  const waiting = migrateSquare({ path: file }, { signal: controller.signal });
  // Let readonly validation finish while this existing writer prevents exclusive acquisition.
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(waiting, e => e === reason);
  blocker.exec('ROLLBACK'); blocker.close();
  assert.deepEqual(snapshot(file), before);
  assert.equal((await migrateSquare({ path: file })).changed, true);
});

test('storage-supported unusual imported strings and dormant leases remain eligible for13 no-op and12 migration', async t => {
  const { file, root } = setup(t), weird = 'A\u0000\ud800';
  const state = { hardCap: null, preamble: ['topic'], warmup: [], acts: [
    { kind: 'say', actor: weird, body: '\udfff\u0000', at: 0.5, index: 2 },
    { kind: 'read', actor: weird, through: 2, at: -2.5, index: 4 },
    { kind: 'done', actor: weird, at: 7, index: 6 },
  ], runtime: { nextActIndex: 10, observations: {}, leases: { DORMANT: { leaseId: '\ud800\u0000', heartbeatAt: 1.25, expiresAt: 2.75 } } } };
  await createSquareFile(file, state);
  const current = snapshot(file), bytes = fs.readFileSync(file);
  assert.equal((await migrateSquare({ path: file })).changed, false);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const old = seedFormat12(path.join(root, 'unusual12.square'));
  const db = new DatabaseSync(old);
  try {
    // Copy the known-valid imported cells into independent historical framing.
    db.exec('BEGIN');
    for (const table of Object.keys(current.tables).filter(name => !name.startsWith('producer_departures') && !name.startsWith('producer_receipt_watermarks'))) {
      db.exec(`DELETE FROM ${table}`);
      for (const row of current.tables[table]) db.prepare(`INSERT INTO ${table} VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  const before = snapshot(old);
  assert.equal((await migrateSquare({ path: old })).changed, true);
  const after = snapshot(old);
  for (const [name, rows] of Object.entries(before.tables)) assert.deepEqual(after.tables[name], rows);
});
