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
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all().map(row => ({ ...row }))])));
}
async function preAttachment(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `square-format${version}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'offline.square');
  const input = { path: file, env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') } };
  const body = { channel: 'test', session: 'offline' };
  const square = await Square.build({ ...input, markdown: 'offline fixture' });
  const alice = (await square.join('Alice', { body })).participant;
  const bob = (await square.join('Bob', { body })).participant;
  const departed = await square.join('Departed', { body });
  await departed.participant.done();
  const activity = (await alice.express({ body: 'preserve', metadata: { source: { kind: 'example' } }, mentions: ['Bob'], force: true })).activity;
  if (version === 5) await bob.deferDelivery({ match: { fields: [{ path: ['other'], equals: true }] }, durationMs: 1000 });
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
      facts.updateWakeAddress(seat, { kind: 'paseo', address: { agentId: 'offline' } });
    });
  } finally { await artifact.close(); }
  // Construct a disposable exact older source, never alter a live artifact.
  inspect(file, db => {
    db.exec('ALTER TABLE seats DROP COLUMN attachment;');
    // Formats 4/5 retained a completed coordinate after done. It must not become restore authority.
    db.prepare('INSERT INTO seats(participant_key_json,participant_json,channel_json,session_json,agent_json,generation_json,wake_address_json) VALUES(?,?,?,?,NULL,?,NULL)')
      .run(JSON.stringify('departed'), JSON.stringify('Departed'), JSON.stringify(body.channel), JSON.stringify(body.session), JSON.stringify(departed.activity.id));
    if (version === 4) db.exec('DROP TABLE delivery_deferrals;');
    db.exec(`PRAGMA user_version=${version};`);
  });
  return { file, input, body };
}

for (const version of [5, 4]) test(`explicit format ${version} -> 6 preserves every fact and revision; only existing seats become attached`, async t => {
  const { file, input, body } = await preAttachment(t, version);
  const before = digest(file), previous = tables(file);
  await assert.rejects(Square.at(input), error => error.facts?.reason === 'migration_required');
  assert.equal(digest(file), before);
  // Additive conversion must not consult a legacy ledger, even an unreadable one.
  const migrated = await migrateSquare({ ...input, env: { ...input.env, SQUARE_HOST_LEDGER_ROOT: '/not/a/legacy/ledger' } });
  assert.equal(migrated.status, 'migrated');
  const after = tables(file);
  assert.ok(after.seats.every(seat => seat.attachment === 'attached'));
  after.seats = after.seats.map(({ attachment, ...row }) => row);
  if (version === 4) { assert.deepEqual(after.delivery_deferrals, []); delete after.delivery_deferrals; }
  assert.deepEqual(after, previous);
  assert.equal(inspect(file, db => db.prepare('PRAGMA user_version').get().user_version), CURRENT_USER_VERSION);
  const square = await Square.at(input);
  assert.deepEqual((await square.seatsOf(body)).map(seat => [seat.name, seat.attachment]), [['Alice', 'attached'], ['Bob', 'attached']]);
  assert.equal((await square.reattach('Departed', { body })), null);
  assert.equal((await square.participants()).participants.find(p => p.name === 'Departed').presence, 'done');
  await square.close();
  assert.deepEqual((await diagnoseSquare(input)).problems, []);
  const current = digest(file);
  assert.equal((await migrateSquare(input)).status, 'already-current');
  assert.equal(digest(file), current, 'current-format migration is byte-preserving');
});

for (const version of [5, 4]) test(`format ${version} migration refuses malformed facts/framing and rolls back publication`, async t => {
  const { file, input } = await preAttachment(t, version);
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
  assert.equal(inspect(file, db => db.prepare('PRAGMA user_version').get().user_version), version);
});
