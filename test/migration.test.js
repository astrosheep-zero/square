import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Square, migrateSquare, diagnoseSquare } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { CURRENT_USER_VERSION, FORMAT6_SCHEMA_SQL } from '../dist/square-sqlite.js';
import { harnessOwner } from '../dist/owner.js';

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
  const coordinate = { channel: 'claude-code', session: 'offline/会话:100%', agent: 'worker:α/1' };
  const body = harnessOwner(coordinate);
  const route = { kind: 'claude-native', address: { sessionId: coordinate.session, endpoint: path.join(root, 'native.sock'), loaded: 'true', platform: 'darwin' } };
  const square = await Square.build({ ...input, markdown: 'offline fixture' });
  const alice = (await square.join('Alice', { owner: body })).participant;
  const bob = (await square.join('Bob', { owner: body })).participant;
  const departed = await square.join('Departed', { owner: body });
  await departed.participant.done();
  const activity = (await alice.express({ body: 'preserve', metadata: { source: { kind: 'example' } }, mentions: ['Bob'], force: true })).activity;
  if (version >= 5) await bob.deferDelivery({ match: { fields: [{ path: ['other'], equals: true }] }, durationMs: 60000 });
  if (version === 6) {
    await square.join('Away', { owner: body });
    const away = (await square.seatsOf(body)).find(seat => seat.name === 'Away');
    await square.detach('Away', { owner: body, generation: away.generation });
  }
  await square.close();
  const artifact = createArtifactPort(file);
  try {
    const seat = (await artifact.read(facts => facts.seat('Bob'))).value;
    const claim = await artifact.claimDelivery({ seat, route, activity: activity.id, kind: 'wake', at: 10, leaseMs: 10, claimToken: 'preserved-claim' });
    assert.equal(claim.status, 'acquired');
    assert.equal(await artifact.completeDelivery({ seat, activity: activity.id, claimToken: claim.claimToken, outcome: 'accepted', at: 20 }), true);
    await artifact.transactAs({ kind: 'participant', seat }, facts => {
      facts.putLease('Bob', { leaseId: 'preserved-catch', heartbeatAt: 100, expiresAt: 1000 }, seat.generation);
      facts.cancelThrough(seat, Number(activity.id.slice(4)));
      facts.markSeen('Bob', [Number(activity.id.slice(4))], 200);
      facts.updateWakeAddress(seat, route);
      facts.observeNativeDelivery({ seat, claimToken: claim.claimToken, observation: { eventId: 'preserved-event', messageId: 'preserved-message', state: 'held', reason: 'explicit-setting', observedAt: 15 } });
    });
  } finally { await artifact.close(); }
  // Construct a disposable exact older source, never alter a live artifact.
  inspect(file, db => {
    const seats = db.prepare('SELECT * FROM seats').all();
    db.exec('DROP TABLE seats;');
    const definition = FORMAT6_SCHEMA_SQL.split(';').find(sql => sql.trim().startsWith('CREATE TABLE seats ('));
    db.exec(`${definition}; CREATE INDEX seat_body ON seats(channel_json, session_json, agent_json);`);
    const insert = db.prepare('INSERT INTO seats(participant_key_json,participant_json,channel_json,session_json,agent_json,generation_json,wake_address_json,attachment) VALUES(?,?,?,?,?,?,?,?)');
    const { channel, session, agent } = coordinate;
    for (const seat of seats) insert.run(seat.participant_key_json, seat.participant_json, JSON.stringify(channel), JSON.stringify(session), JSON.stringify(agent), seat.generation_json, seat.wake_address_json, seat.attachment);
    // Older formats retained a completed coordinate after done. It never becomes restore authority.
    insert.run('"departed"', '"Departed"', JSON.stringify(channel), JSON.stringify(session), JSON.stringify(agent), JSON.stringify(departed.activity.id), null, 'attached');
    if (version < 6) db.exec('ALTER TABLE seats DROP COLUMN attachment;');
    if (version === 4) db.exec('DROP TABLE delivery_deferrals;');
    db.exec(`PRAGMA user_version=${version};`);
  });
  return { file, input, body };
}

for (const version of [6, 5, 4]) test(`explicit format ${version} -> 7 preserves every fact, revision and attachment`, async t => {
  const { file, input, body } = await preAttachment(t, version);
  const before = digest(file), previous = tables(file);
  await assert.rejects(Square.at(input), error => error.facts?.reason === 'migration_required');
  assert.equal(digest(file), before);
  // Additive conversion must not consult a legacy ledger, even an unreadable one.
  const migrated = await migrateSquare({ ...input, env: { ...input.env, SQUARE_HOST_LEDGER_ROOT: '/not/a/legacy/ledger' } });
  assert.equal(migrated.status, 'migrated');
  const after = tables(file);
  previous.seats = previous.seats.map(({ channel_json, session_json, agent_json, ...row }) => ({ ...row,
    owner_json: JSON.stringify(harnessOwner({ channel: JSON.parse(channel_json), session: JSON.parse(session_json),
      ...(agent_json === null ? {} : { agent: JSON.parse(agent_json) }) })), attachment: row.attachment ?? 'attached' }));
  if (version === 4) { assert.deepEqual(after.delivery_deferrals, []); delete after.delivery_deferrals; }
  assert.deepEqual(after, previous);
  assert.equal(inspect(file, db => db.prepare('PRAGMA user_version').get().user_version), CURRENT_USER_VERSION);
  const square = await Square.at(input);
  assert.deepEqual((await square.seatsOf(body)).map(seat => [seat.name, seat.attachment]), [['Alice', 'attached'], ...(version === 6 ? [['Away', 'detached']] : []), ['Bob', 'attached']]);
  assert.equal((await square.reattach('Departed', { owner: body })), null);
  assert.equal((await square.participants()).participants.find(p => p.name === 'Departed').presence, 'done');
  await square.close();
  assert.deepEqual((await diagnoseSquare(input)).problems, []);
  const current = digest(file);
  assert.equal((await migrateSquare(input)).status, 'already-current');
  assert.equal(digest(file), current, 'current-format migration is byte-preserving');
});

for (const version of [6, 5, 4]) test(`format ${version} migration refuses malformed facts/framing and rolls back publication`, async t => {
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
  inspect(file, db => db.prepare('UPDATE seats SET session_json=?').run(JSON.stringify('界'.repeat(100))));
  before = digest(file);
  await assert.rejects(migrateSquare(input), /owner|512/i);
  assert.equal(digest(file), before, 'an unrepresentable owner leaves the legacy artifact intact');
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
