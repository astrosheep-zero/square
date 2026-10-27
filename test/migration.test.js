import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Square, migrateSquare, diagnoseSquare } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { CURRENT_USER_VERSION } from '../dist/square-sqlite.js';

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inspect(file, callback) {
  const database = new DatabaseSync(file);
  try { return callback(database); } finally { database.close(); }
}
function tables(file) {
  return inspect(file, db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all()])));
}
async function format4(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-format4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'offline.square');
  const input = { path: file, env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') }, body: { channel: 'test', session: 'offline' } };
  const square = await Square.build({ ...input, markdown: 'format4 fixture' });
  const alice = (await square.join('Alice')).participant;
  await square.join('Bob');
  const activity = (await alice.express({ body: 'preserve', metadata: { source: { kind: 'example' } }, mentions: ['Bob'], force: true })).activity;
  await square.close();
  const artifact = createArtifactPort(file);
  try {
    const seat = (await artifact.read(facts => facts.seat('Bob'))).value;
    const claim = await artifact.claimDelivery({ seat, activity: activity.id, kind: 'wake', at: 10, leaseMs: 10, claimToken: 'preserved-claim' });
    assert.equal(claim.status, 'acquired');
    assert.equal(await artifact.completeDelivery({ seat, activity: activity.id, claimToken: claim.claimToken, outcome: 'accepted', at: 20 }), true);
    await artifact.transactAs({ kind: 'participant', seat }, facts => {
      facts.putLease('Bob', { leaseId: 'preserved-catch', heartbeatAt: 100, expiresAt: 1000 }, seat.generation);
      facts.cancelThrough(seat, Number(activity.id.slice(4)));
      facts.markSeen('Bob', [Number(activity.id.slice(4))], 200);
    });
    await artifact.transactAs({ kind: 'participant', seat }, facts => facts.updateWakeAddress(seat, { kind: 'paseo', address: { agentId: 'offline' } }));
  } finally { await artifact.close(); }
  // This constructs a disposable exact format-4 source; it is not a live migration.
  inspect(file, db => db.exec('DROP TABLE delivery_deferrals; PRAGMA user_version=4;'));
  return { file, input };
}

test('offline format4 upgrades add only deferral storage, preserve all facts/revisions and remain explicit', async t => {
  const { file, input } = await format4(t);
  const before = digest(file), previous = tables(file);
  await assert.rejects(Square.at(input), error => error.facts?.reason === 'migration_required');
  assert.equal(digest(file), before);
  const migrated = await migrateSquare(input);
  assert.equal(migrated.status, 'migrated');
  const after = tables(file);
  assert.deepEqual(after.delivery_deferrals, []);
  delete after.delivery_deferrals;
  assert.deepEqual(after, previous);
  assert.equal(inspect(file, db => db.prepare('PRAGMA user_version').get().user_version), CURRENT_USER_VERSION);
  const square = await Square.at(input);
  const bob = await square.participant('Bob');
  const lease = await bob.deferDelivery({ match: { fields: [{ path: ['source', 'kind'], equals: 'example' }] }, durationMs: 1000 });
  assert.ok(lease.id);
  await square.close();
  await diagnoseSquare(input);
  const current = digest(file);
  assert.equal((await migrateSquare(input)).status, 'already-current');
  assert.equal(digest(file), current, 'current-format migration is byte-preserving');
});

test('format4 migration refuses malformed authority/unknown framing and rolls back publication on failure', async t => {
  const { file, input } = await format4(t);
  const original = fs.readFileSync(file);
  inspect(file, db => db.exec('CREATE TABLE foreign_data (value TEXT);'));
  let before = digest(file);
  await assert.rejects(migrateSquare(input), /schema/);
  assert.equal(digest(file), before);
  fs.writeFileSync(file, original);
  inspect(file, db => db.prepare('UPDATE seats SET generation_json=?').run('"invalid"'));
  before = digest(file);
  await assert.rejects(migrateSquare(input), /artifact/);
  assert.equal(digest(file), before);
  fs.writeFileSync(file, original);
  before = digest(file);
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql, ...args) {
    const result = exec.call(this, sql, ...args);
    if (sql === `PRAGMA user_version = ${CURRENT_USER_VERSION};`) throw new Error('injected publication failure');
    return result;
  });
  await assert.rejects(migrateSquare(input), /injected publication failure/);
  assert.equal(digest(file), before);
  assert.equal(inspect(file, db => db.prepare('PRAGMA user_version').get().user_version), 4);
});
