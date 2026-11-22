import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryLedger, migrateDeliveryLedger } from '../dist/ledger/delivery-ledger.js';
import { migrateDeliveryLedger as rootMigration } from '../dist/index.js';
import { migrateDeliveryLedger as squareApiMigration } from '../dist/api/square-api.js';
import { squarePostKey } from '../dist/core/delivery-key.js';

const FORMAT4_SCHEMA = `CREATE TABLE meta (format INTEGER NOT NULL, next_seq INTEGER NOT NULL, next_receipt_seq INTEGER NOT NULL);
CREATE TABLE sessions (owner TEXT PRIMARY KEY, generation TEXT NOT NULL, state TEXT NOT NULL, routes_json TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE cards (seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, details TEXT, posted_at REAL NOT NULL, UNIQUE(owner,key));
CREATE INDEX cards_owner ON cards(owner,seq);
CREATE TABLE suppressions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('exact','prefix')), created_at REAL NOT NULL, expires_at REAL);
CREATE INDEX suppressions_owner ON suppressions(owner);
CREATE INDEX suppressions_exact_key ON suppressions(owner,key) WHERE scope='exact';
CREATE INDEX suppressions_prefix_owner ON suppressions(owner) WHERE scope='prefix';
CREATE INDEX suppressions_expiry ON suppressions(expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX suppressions_permanent_exact ON suppressions(owner,key) WHERE scope='exact' AND expires_at IS NULL;
CREATE INDEX suppressions_permanent_created ON suppressions(created_at) WHERE expires_at IS NULL;
CREATE TABLE attempts (token TEXT PRIMARY KEY, seq INTEGER NOT NULL, generation TEXT NOT NULL, track TEXT NOT NULL, route_kind TEXT, outcome TEXT NOT NULL, correlation_json TEXT NOT NULL, started_at REAL NOT NULL, expires_at REAL NOT NULL, settled_at REAL);
CREATE INDEX attempts_seq ON attempts(seq);
CREATE TABLE receipts (seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, at REAL NOT NULL, UNIQUE(owner,key));
CREATE INDEX receipts_owner_seq ON receipts(owner,seq);
CREATE INDEX receipts_time ON receipts(at);
CREATE TABLE cancellations (owner TEXT PRIMARY KEY, generation TEXT NOT NULL, through_seq INTEGER NOT NULL);`;
const owner = 'migration:owner', other = 'migration:other';
const square = '/tmp/界#x/with%_space.square';
const activity = `square:${square}#act/7/recipient/%E7%8C%AB%2Fbob/join/gen%2F%23%25`;
const notice = `square:${square}#notice/3/recipient/alice/join/notice-gen`;
const exact = new Map([
  ['opaque/held', ['opaque', 'held']], ['opaque/receipt', ['opaque', 'receipt']],
  ['opaque/tombstone', ['opaque', 'tombstone']],
]);
const options = { convertOpaqueKey: key => exact.get(key), convertOpaquePrefix: key => key === 'opaque/' ? ['opaque'] : undefined };
const snapshot = location => {
  const db = new DatabaseSync(location, { readOnly: true });
  try {
    return Object.fromEntries(['meta', 'sessions', 'cards', 'suppressions', 'attempts', 'receipts', 'cancellations']
      .map(table => [table, db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
  } finally { db.close(); }
};
async function legacy(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'delivery.v4.sqlite');
  const db = new DatabaseSync(location);
  try {
    db.exec(FORMAT4_SCHEMA + '; PRAGMA application_id=1145849682; PRAGMA user_version=4');
    db.prepare('INSERT INTO meta VALUES(4,100,80)').run();
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(owner, 'generation', 'detached', '[{"kind":"socket","address":{"url":"opaque"}}]', 123);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(other, 'deleted-generation', 'deleted', '[]', 321);
    const card = db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?)');
    card.run(2, owner, activity, 'activity text', '{"body":"full","x":7}', 11);
    card.run(9, owner, notice, 'notice text', null, 12);
    card.run(11, other, 'opaque/held', '', null, 13);
    const suppression = db.prepare('INSERT INTO suppressions VALUES(?,?,?,?,?,?)');
    suppression.run('square-prefix', owner, `square:${square}#`, 'prefix', 14, 99);
    suppression.run('square-tombstone', owner, activity, 'exact', 15, null);
    suppression.run('opaque-prefix', other, 'opaque/', 'prefix', 16, 200);
    suppression.run('opaque-tombstone', other, 'opaque/tombstone', 'exact', 17, null);
    suppression.run('expired', other, 'opaque/held', 'exact', 18, 19);
    const attempt = db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?)');
    attempt.run('unknown-token', 11, 'deleted-generation', 'handoff', 'socket', 'unknown', '{"token":"effect","messageId":"message","payloadHash":"hash"}', 20, 21, 22);
    attempt.run('dispatch-token', 9, 'generation', 'presentation', null, 'dispatching', '{}', 23, 24, null);
    attempt.run('failed-token', 2, 'generation', 'handoff', 'socket', 'failed', '{}', 25, 26, 27);
    db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(31, owner, activity, 28);
    db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(72, other, 'opaque/receipt', 29);
    db.prepare('INSERT INTO cancellations VALUES(?,?,?)').run(owner, 'generation', 77);
  } finally { db.close(); }
  return { location, root };
}

test('explicit Format4 migration preserves custody, rows, counters and producer-owned conversions without GC', async t => {
  assert.equal(rootMigration, migrateDeliveryLedger);
  assert.equal(squareApiMigration, migrateDeliveryLedger);
  const { location } = await legacy(t), before = snapshot(location);
  const bytes = await fs.readFile(location);
  await assert.rejects(DeliveryLedger.open({ location }), /format/);
  assert.deepEqual(await fs.readFile(location), bytes);
  const keys = new Map(), prefixes = new Map();
  const result = await migrateDeliveryLedger({ location,
    convertOpaqueKey: key => { keys.set(key, (keys.get(key) ?? 0) + 1); return options.convertOpaqueKey(key); },
    convertOpaquePrefix: key => { prefixes.set(key, (prefixes.get(key) ?? 0) + 1); return options.convertOpaquePrefix(key); },
  });
  assert.deepEqual(result, { location, fromVersion: 4, toVersion: 5, changed: true });
  assert.deepEqual([...keys.values()], [1, 1, 1]);
  assert.deepEqual([...prefixes], [['opaque/', 1]]);
  const after = snapshot(location);
  const known = new Map([
    [activity, squarePostKey(square, { kind: 'activity', index: 7, recipient: '猫/bob', generation: 'gen/#%' })],
    [notice, squarePostKey(square, { kind: 'notice', index: 3, recipient: 'alice', generation: 'notice-gen' })],
    [`square:${square}#`, ['square', square]], ['opaque/', ['opaque']], ...exact,
  ]);
  const expected = structuredClone(before);
  expected.meta[0].format = 5;
  for (const table of ['cards', 'receipts', 'suppressions']) for (const row of expected[table]) row.key = JSON.stringify(known.get(row.key));
  // Rebuilt tables retain all public sequence identities; physical rowids of TEXT-primary-key suppressions stay in insertion order too.
  assert.deepEqual(after, expected);
  const migratedBytes = await fs.readFile(location);
  assert.deepEqual(await migrateDeliveryLedger({ location }), { location, fromVersion: 5, toVersion: 5, changed: false });
  assert.deepEqual(await fs.readFile(location), migratedBytes);
  const ledger = await DeliveryLedger.open({ location, clock: () => 30 });
  try {
    assert.equal((await ledger.session(owner)).generation, 'generation');
    assert.deepEqual((await ledger.receipts(other, { keys: [['opaque', 'receipt']] }))[0].key, ['opaque', 'receipt']);
  } finally { await ledger.close(); }
});

test('missing opaque mappings, invalid converter results, collisions and changed prefix membership refuse before writes', async t => {
  const { location } = await legacy(t), original = await fs.readFile(location);
  for (const input of [
    {}, { convertOpaqueKey: options.convertOpaqueKey },
    { ...options, convertOpaqueKey: () => ['collision'] },
    { ...options, convertOpaqueKey: () => [] },
    { ...options, convertOpaqueKey: () => ['invalid', 1] },
    { ...options, convertOpaqueKey: () => new Array(1) },
    { ...options, convertOpaqueKey: () => Promise.resolve(['async']) },
    { ...options, convertOpaquePrefix: () => ['opaque', 'held'] },
  ]) {
    await assert.rejects(migrateDeliveryLedger({ location, ...input }));
    assert.deepEqual(await fs.readFile(location), original);
  }
});

test('malformed Square lookalikes and partial historical prefixes require explicit producer converters', async t => {
  const { location } = await legacy(t);
  const db = new DatabaseSync(location);
  const malformed = `square:${square}#act/07/recipient/bob/join/gen`;
  const partial = `square:${square}#act/`;
  db.prepare('INSERT INTO receipts VALUES(73,?,?,30)').run(owner, malformed);
  db.prepare('INSERT INTO suppressions VALUES(?,?,?,\'prefix\',30,400)').run('partial', owner, partial);
  db.close();
  const bytes = await fs.readFile(location);
  await assert.rejects(migrateDeliveryLedger({ location, ...options }), /opaque/);
  assert.deepEqual(await fs.readFile(location), bytes);
  await migrateDeliveryLedger({ location,
    convertOpaqueKey: key => key === malformed ? ['square', square, 'recipient', '猫/bob', 'legacy-malformed'] : options.convertOpaqueKey(key),
    convertOpaquePrefix: prefix => prefix === partial ? ['square', square, 'recipient', '猫/bob'] : options.convertOpaquePrefix(prefix),
  });
  assert.deepEqual(JSON.parse(snapshot(location).receipts.at(-1).key), ['square', square, 'recipient', '猫/bob', 'legacy-malformed']);
});

test('write failure and cancellation roll back migration and repeat Format5 fully validates keys', async t => {
  const { location } = await legacy(t), original = await fs.readFile(location);
  const exec = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql.startsWith('UPDATE meta SET format=5')) throw new Error('injected migration failure');
    return Reflect.apply(exec, this, [sql]);
  });
  await assert.rejects(migrateDeliveryLedger({ location, ...options }), /injected migration failure/);
  fault.mock.restore();
  assert.deepEqual(await fs.readFile(location), original);
  const controller = new AbortController();
  await assert.rejects(migrateDeliveryLedger({ location, ...options, convertOpaqueKey: key => {
    controller.abort(new Error('cancel conversion')); return options.convertOpaqueKey(key);
  } }, { signal: controller.signal }), /cancel conversion/);
  assert.deepEqual(await fs.readFile(location), original);
  await migrateDeliveryLedger({ location, ...options });
  const db = new DatabaseSync(location);
  db.prepare('UPDATE receipts SET key=? WHERE seq=72').run('[ "opaque", "receipt" ]'); db.close();
  const invalid = await fs.readFile(location);
  await assert.rejects(migrateDeliveryLedger({ location }), /evidence/);
  assert.deepEqual(await fs.readFile(location), invalid);
});

test('absent files, unsupported versions and damaged historical schemas never open writable or cut over filename', async t => {
  const { location, root } = await legacy(t);
  const missing = path.join(root, 'missing.sqlite');
  await assert.rejects(migrateDeliveryLedger({ location: missing }));
  await assert.rejects(fs.access(missing), { code: 'ENOENT' });
  const db = new DatabaseSync(location); db.exec('PRAGMA user_version=3'); db.close();
  const original = await fs.readFile(location);
  await assert.rejects(migrateDeliveryLedger({ location, ...options }), /format/);
  assert.deepEqual(await fs.readFile(location), original);
  const damaged = new DatabaseSync(location); damaged.exec('PRAGMA user_version=4; DROP INDEX receipts_time'); damaged.close();
  const bytes = await fs.readFile(location);
  await assert.rejects(migrateDeliveryLedger({ location, ...options }), /schema/);
  assert.deepEqual(await fs.readFile(location), bytes);
  assert.deepEqual((await fs.readdir(root)).sort(), ['delivery.v4.sqlite']);
});
