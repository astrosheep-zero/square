import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Square, migrateSquare, diagnoseSquare } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { FORMAT7_SCHEMA_SQL } from '../dist/square-sqlite.js';

function inspect(file, callback) {
  const db = new DatabaseSync(file);
  try { return callback(db); } finally { db.close(); }
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v7-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { path: path.join(root, 'offline.square'), env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') } };
  const square = await Square.build({ ...input, markdown: 'format seven' });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  await square.join('Bob', { owner: 'test:bob' });
  await alice.express({ body: 'surviving attention', mentions: ['Bob'], force: true });
  await square.close();
  inspect(input.path, db => {
    const rows = db.prepare('SELECT * FROM activities ORDER BY act_index').all();
    db.exec('DROP TABLE activities;');
    db.exec(FORMAT7_SCHEMA_SQL.split(';').find(sql => sql.trim().startsWith('CREATE TABLE activities (')) + ';');
    for (const sql of FORMAT7_SCHEMA_SQL.split(';').filter(sql => /CREATE INDEX activity_/.test(sql))) db.exec(sql + ';');
    const insert = db.prepare('INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json) VALUES(?,?,?,?,?,?,?,?)');
    for (const row of rows) insert.run(...Object.values(row));
    const at = Date.now();
    insert.run(3, at + 3, 'hold', '"Bob"', '"bob"', null, null, '{"body":"old pause"}');
    insert.run(4, at + 4, 'resume', null, null, null, null, '{}');
    insert.run(5, at + 5, 'say', '"Alice"', '"alice"', null, 3, '{"body":"old reply"}');
    insert.run(6, at + 6, 'hold', '"Carol"', '"carol"', null, null, '{}');
    insert.run(7, at + 7, 'hold', '"Bob"', '"bob"', null, null, '{}');
    db.prepare('UPDATE participants SET say_count=2,last_active_at=? WHERE name_json=?').run(at + 5, '"Alice"');
    db.prepare('UPDATE participants SET last_active_at=? WHERE name_json=?').run(at + 7, '"Bob"');
    db.prepare('INSERT INTO participants VALUES(?,?,?,?,?,?,?,?)').run('"carol"', '"Carol"', 6, 0, 0, 0, at + 6, null);
    db.exec(`
      INSERT INTO landed_audience VALUES(5,'"bob"',0,'reply');
      INSERT INTO landed_audience VALUES(3,'"bob"',0,'mention');
      INSERT INTO receipts VALUES('"Alice"',5,50);
      INSERT INTO receipts VALUES('"Bob"',3,30);
      INSERT INTO receipts VALUES('"Bob"',4,40);
      INSERT INTO receipts VALUES('"Bob"',7,70);
      INSERT INTO delivery_evidence VALUES('"bob"','"Bob"','"act/1"',2,'wake',0,'accepted',20,NULL,'"keep-token"','{}');
      INSERT INTO delivery_evidence VALUES('"bob"','"Bob"','"act/1"',3,'wake',0,'accepted',30,NULL,'"drop-token"','{}');
      INSERT INTO delivery_cancellations VALUES('"bob"','"act/1"',7);
      UPDATE square_meta SET next_act_index=8;
      PRAGMA user_version=7;
    `);
  });
  return input;
}

test('explicit format 7 -> 8 drops obsolete activity identities while preserving sparse ids and allocator', async t => {
  const input = await fixture(t);
  const before = fs.readFileSync(input.path);
  await assert.rejects(Square.at(input), error => error.facts?.reason === 'migration_required');
  assert.deepEqual(fs.readFileSync(input.path), before, 'ordinary open does not rewrite legacy bytes');
  const previousMeta = inspect(input.path, db => ({ ...db.prepare('SELECT * FROM square_meta').get() }));
  assert.equal((await migrateSquare({ ...input, env: { ...input.env, SQUARE_HOST_LEDGER_ROOT: '/not/a/legacy/ledger' } })).status, 'migrated');
  inspect(input.path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.deepEqual({ ...db.prepare('SELECT * FROM square_meta').get() }, previousMeta);
    assert.deepEqual(db.prepare('SELECT act_index,reply_index FROM activities ORDER BY act_index').all().map(row => ({ ...row })), [
      { act_index: 0, reply_index: null }, { act_index: 1, reply_index: null },
      { act_index: 2, reply_index: null }, { act_index: 5, reply_index: null },
    ]);
    assert.deepEqual(db.prepare('SELECT act_index FROM receipts').all().map(row => row.act_index), [5]);
    assert.deepEqual(db.prepare('SELECT act_index FROM landed_audience').all().map(row => row.act_index), [2]);
    assert.deepEqual(db.prepare('SELECT act_index,claim_token_json FROM delivery_evidence').all().map(row => ({ ...row })), [{ act_index: 2, claim_token_json: '"keep-token"' }]);
    assert.equal(db.prepare('SELECT through_index FROM delivery_cancellations').get().through_index, 7, 'a range watermark is not an activity identity');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM participants WHERE name_json='\"Carol\"'").get().n, 0);
    const bob = db.prepare("SELECT last_active_at FROM participants WHERE name_json='\"Bob\"'").get();
    assert.equal(bob.last_active_at, db.prepare('SELECT at FROM activities WHERE act_index=1').get().at);
  });
  assert.deepEqual((await diagnoseSquare(input)).problems, []);

  const artifact = createArtifactPort(input.path);
  try {
    const facts = (await artifact.read(read => ({ header: read.header(), ordinals: read.sayOrdinals([2, 3, 5, 7]), alice: read.seat('Alice'), bob: read.seat('Bob') }))).value;
    assert.equal(facts.header.lastActIndex, 5);
    assert.equal(facts.header.nextActIndex, 8);
    assert.deepEqual(facts.ordinals, { 2: 1, 5: 2 });
    assert.equal((await artifact.transactAs({ kind: 'participant', seat: facts.alice }, write => write.cancelThrough(facts.alice, 3))).value, true, 'an interior deleted coordinate is a valid range boundary');
    assert.equal((await artifact.transactAs({ kind: 'participant', seat: facts.alice }, write => write.cancelThrough(facts.alice, 7))).value, true, 'the removed tail remains an assigned boundary');
    await assert.rejects(artifact.transactAs({ kind: 'participant', seat: facts.alice }, write => write.cancelThrough(facts.alice, 8)), /boundary/);
    assert.equal((await artifact.transactAs({ kind: 'participant', seat: facts.bob }, write => write.cancelThrough(facts.bob, 7))).value, false);
  } finally { await artifact.close(); }

  const square = await Square.at(input);
  try {
    assert.deepEqual((await square.history({ after: 'act/3', limit: null })).activities.map(act => act.id), ['act/5']);
    assert.deepEqual((await square.history({ before: 'act/4', limit: null })).activities.map(act => act.id), ['act/0', 'act/1', 'act/2']);
    const page = await square.history({ after: 'act/1', limit: 1, observe: true });
    assert.deepEqual(page.activities.map(act => act.id), ['act/2']);
    assert.deepEqual(page.observation.continuation, { direction: 'after', cursor: 'act/2', limit: 1 });
    assert.deepEqual((await square.history({ after: page.observation.continuation.cursor, limit: 1 })).activities.map(act => act.id), ['act/5']);
    assert.deepEqual((await square.history({ at: ['act/5'], contextBefore: 1 })).activities.map(act => act.id), ['act/2', 'act/5']);
    assert.deepEqual((await square.history({ after: 'act/7', limit: null })).activities, []);
    const stream = square.stream({ start: { kind: 'after', after: 'act/3' } })[Symbol.asyncIterator]();
    try { assert.equal((await stream.next()).value.id, 'act/5'); }
    finally { await stream.return(); }
    const alice = await square.participant('Alice', { owner: 'test:alice' });
    const bob = await square.participant('Bob', { owner: 'test:bob' });
    const expressed = await alice.express({ body: 'after the gap', mentions: ['Bob'], force: true });
    assert.equal(expressed.activity.id, 'act/8', 'no deleted index is reused');
    assert.deepEqual((await bob.catch({ limit: 10 })).activities.map(act => act.id), ['act/2', 'act/8']);
    assert.equal((await square.status()).participants.length, 2);
    assert.equal((await square.history({ limit: null })).activities.filter(act => act.kind === 'say').length, 3);
  } finally { await square.close(); }
  assert.deepEqual((await diagnoseSquare(input)).problems, []);
  const current = fs.readFileSync(input.path);
  assert.equal((await migrateSquare(input)).status, 'already-current');
  assert.deepEqual(fs.readFileSync(input.path), current);
});

for (const version of [2, 3]) test(`format ${version} chains through activity deletion without a legacy runtime decoder`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `square-v${version}-deletion-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { path: path.join(root, 'legacy.square'), env: { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'unused-ledger'), SQUARE_INDEX: path.join(root, 'index.ndjsonl') } };
  inspect(input.path, db => {
    db.exec(fs.readFileSync(new URL(`./fixtures/v${version}-artifact.sql`, import.meta.url), 'utf8'));
    db.exec(`
      INSERT INTO activities VALUES(8,1020,'hold','"Bob"','"bob"',NULL,NULL,'{}');
      INSERT INTO activities VALUES(9,1021,'resume',NULL,NULL,NULL,NULL,'{}');
      INSERT INTO activities VALUES(10,1022,'say','"Alice"','"alice"',NULL,8,'{"body":"legacy reply"}');
      INSERT INTO activities VALUES(11,1023,'hold','"Bob"','"bob"',NULL,NULL,'{}');
      INSERT INTO receipts VALUES('"Bob"',8,1024);
      INSERT INTO landed_audience VALUES(10,'"bob"',0,'reply');
      UPDATE participants SET last_active_at=1023 WHERE name_json='"Bob"';
      UPDATE participants SET say_count=3,last_active_at=1022 WHERE name_json='"Alice"';
      UPDATE square_meta SET next_act_index=12;
    `);
  });
  assert.equal((await migrateSquare(input)).status, 'migrated');
  inspect(input.path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare('SELECT next_act_index FROM square_meta').get().next_act_index, 12);
    assert.deepEqual(db.prepare('SELECT act_index FROM activities WHERE act_index>=8').all().map(row => row.act_index), [10]);
    assert.equal(db.prepare('SELECT reply_index FROM activities WHERE act_index=10').get().reply_index, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE act_index=8').get().n, 0);
    const audience = db.prepare('SELECT route FROM landed_audience WHERE act_index=10').get();
    assert.equal(audience?.route, version === 2 ? 'attention' : undefined);
  });
  assert.deepEqual((await diagnoseSquare(input)).problems, []);
});

test('migration retains established participant casing when its first activity is deleted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v7-casing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { path: path.join(root, 'casing.square'), env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') } };
  inspect(input.path, db => {
    db.exec(FORMAT7_SCHEMA_SQL);
    db.exec(`
      PRAGMA application_id=1397838405;
      PRAGMA user_version=7;
      INSERT INTO square_meta VALUES(1,5,0,5,NULL,NULL,'[]','[]');
      INSERT INTO activities VALUES(0,0,'hold','"aLiCe"','"alice"',NULL,NULL,'{}');
      INSERT INTO activities VALUES(1,1,'join','"ALICE"','"alice"',NULL,NULL,'{}');
      INSERT INTO activities VALUES(2,2,'join','"Bob"','"bob"',NULL,NULL,'{}');
      INSERT INTO activities VALUES(3,3,'say','"alice"','"alice"',NULL,NULL,'{"body":"hello","mentions":["Bob"]}');
      INSERT INTO activities VALUES(4,4,'say','"Bob"','"bob"',NULL,3,'{"body":"reply"}');
      INSERT INTO participants VALUES('"alice"','"aLiCe"',0,1,0,1,3,1);
      INSERT INTO participants VALUES('"bob"','"Bob"',2,1,0,1,4,2);
      INSERT INTO landed_audience VALUES(3,'"bob"',0,'mention');
      INSERT INTO landed_audience VALUES(4,'"alice"',0,'reply');
      INSERT INTO receipts VALUES('"aLiCe"',4,5);
      INSERT INTO seats VALUES('"alice"','"aLiCe"','"test:alice"','"act/1"',NULL,'attached');
      INSERT INTO seats VALUES('"bob"','"Bob"','"test:bob"','"act/2"',NULL,'attached');
    `);
  });
  await migrateSquare(input);
  assert.deepEqual((await diagnoseSquare(input)).problems, []);
  const artifact = createArtifactPort(input.path);
  try {
    const facts = (await artifact.read(read => ({ participant: read.participant('ALICE'), seat: read.seat('alice'), receipt: read.receipt('alice', 4), reply: read.directedAt('alice', 4) }))).value;
    assert.equal(facts.participant.name, 'aLiCe');
    assert.equal(facts.participant.firstIndex, 1);
    assert.equal(facts.seat.participant, 'aLiCe');
    assert.equal(facts.seat.generation, 'act/1');
    assert.deepEqual(facts.receipt, { at: 5 });
    assert.equal(facts.reply.recipient, 'aLiCe');
  } finally { await artifact.close(); }
  const square = await Square.at(input);
  try {
    const alice = await square.participant('alice', { owner: 'test:alice' });
    assert.deepEqual((await alice.catch({ limit: 10 })).activities, [], 'the retained canonical receipt still suppresses an already-read reply');
    assert.equal((await alice.express({ body: 'still me', mentions: ['Bob'], force: true })).activity.actor, 'aLiCe');
  } finally { await square.close(); }
  assert.deepEqual((await diagnoseSquare(input)).problems, []);
});

test('deleting the entire legacy activity stream preserves the allocator for the next join', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v7-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { path: path.join(root, 'empty.square'), env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') } };
  inspect(input.path, db => {
    db.exec(FORMAT7_SCHEMA_SQL);
    db.exec(`
      PRAGMA application_id=1397838405;
      PRAGMA user_version=7;
      INSERT INTO square_meta VALUES(1,2,0,2,NULL,NULL,'[]','[]');
      INSERT INTO activities VALUES(0,0,'resume',NULL,NULL,NULL,NULL,'{}');
      INSERT INTO activities VALUES(1,1,'hold',NULL,NULL,NULL,NULL,'{}');
    `);
  });
  await migrateSquare(input);
  const artifact = createArtifactPort(input.path);
  try {
    const header = (await artifact.read(facts => facts.header())).value;
    assert.equal(header.lastActIndex, -1);
    assert.equal(header.nextActIndex, 2);
  } finally { await artifact.close(); }
  const square = await Square.at(input);
  try {
    assert.deepEqual((await square.history()).activities, []);
    assert.deepEqual((await square.status()).participants, []);
    assert.equal((await square.join('Alice', { owner: 'test:alice' })).activity.id, 'act/2');
  } finally { await square.close(); }
  assert.deepEqual((await diagnoseSquare(input)).problems, []);
});

test('format 7 migration rolls back deletions and schema publication together', async t => {
  const input = await fixture(t);
  const before = fs.readFileSync(input.path);
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql, ...args) {
    const result = exec.call(this, sql, ...args);
    if (sql === 'PRAGMA user_version = 8;') throw new Error('injected publication failure');
    return result;
  });
  await assert.rejects(migrateSquare(input), /injected publication failure/);
  assert.deepEqual(fs.readFileSync(input.path), before);
});
