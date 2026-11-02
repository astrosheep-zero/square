import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Square, migrateSquare, diagnoseSquare } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { CURRENT_USER_VERSION, FORMAT6_SCHEMA_SQL, FORMAT7_SCHEMA_SQL, FORMAT8_SCHEMA_SQL } from '../dist/square-sqlite.js';
import { harnessOwner } from '../dist/owner.js';
import { observeClaudeDelivery } from '../dist/claude-delivery.js';
import { rememberSquarePath } from '../dist/square-index.js';

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inspect(file, callback) {
  const database = new DatabaseSync(file);
  try { return callback(database); } finally { database.close(); }
}
function tables(file) {
  return inspect(file, db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all().map(row => ({ ...row }))])));
}
function legacyActivities(db, schema = FORMAT7_SCHEMA_SQL) {
  const rows = db.prepare('SELECT * FROM activities ORDER BY act_index').all();
  db.exec('DROP TABLE activities;');
  db.exec(schema.split(';').find(sql => sql.trim().startsWith('CREATE TABLE activities (')) + ';');
  for (const sql of schema.split(';').filter(sql => /CREATE INDEX activity_/.test(sql))) db.exec(sql + ';');
  const insert = db.prepare('INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json) VALUES(?,?,?,?,?,?,?,?)');
  for (const row of rows) insert.run(...Object.values(row));
}
function legacyAudience(db, schema = FORMAT7_SCHEMA_SQL) {
  const rows = db.prepare('SELECT * FROM landed_audience ORDER BY act_index,recipient_order').all();
  db.exec('DROP TABLE landed_audience;');
  db.exec(schema.split(';').find(sql => sql.trim().startsWith('CREATE TABLE landed_audience (')) + ';');
  for (const sql of schema.split(';').filter(sql => /CREATE INDEX audience_/.test(sql))) db.exec(sql + ';');
  const insert = db.prepare('INSERT INTO landed_audience(act_index,recipient_key_json,recipient_order,route) VALUES(?,?,?,?)');
  for (const row of rows) insert.run(row.act_index, row.recipient_key_json, row.recipient_order, row.route);
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
    legacyActivities(db);
    legacyAudience(db);
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

for (const version of [6, 5, 4]) test(`explicit format ${version} -> 9 preserves every surviving fact, revision and attachment`, async t => {
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
  const generations = new Map(previous.participants.map(row => [row.name_key_json,
    row.last_join_index === null ? null : JSON.stringify(`act/${row.last_join_index}`)]));
  previous.landed_audience = previous.landed_audience.map(row => ({ ...row,
    generation_json: generations.get(row.recipient_key_json) ?? null }));
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

test('explicit format 8 -> 9 converts direct deliveries to native messages without losing identities or evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-format8-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { path: path.join(root, 'v8.square'), env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') } };
  const square = await Square.build({ ...input, markdown: 'format eight fixture' });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  await square.join('Bob', { owner: 'test:bob' });
  const direct = (await alice.express({ body: 'legacy direct body', metadata: { job: { id: 7 } }, mentions: ['Bob'], force: true })).activity;
  const agora = (await alice.express({ body: 'ordinary agora', force: true })).activity;
  const seat = (await square.artifact.read(facts => facts.seat('Bob'))).value;
  const route = { kind: 'paseo', address: { agentId: 'bob' } };
  const claim = await square.artifact.claimDelivery({ seat, route, activity: direct.id, kind: 'wake', at: 10, leaseMs: 10, claimToken: 'v8-claim' });
  assert.equal(claim.status, 'acquired');
  assert.equal(await square.artifact.completeDelivery({ seat, activity: direct.id, claimToken: claim.claimToken, outcome: 'accepted', at: 20 }), true);
  await square.artifact.transactAs({ kind: 'participant', seat }, facts => {
    facts.markSeen('Bob', [Number(direct.id.slice(4))], 50);
    facts.cancelThrough(seat, Number(direct.id.slice(4)));
  });
  await square.close();

  let metadataOnly;
  inspect(input.path, db => {
    const at = Date.now(), next = db.prepare('SELECT next_act_index FROM square_meta').get().next_act_index;
    metadataOnly = `act/${next}`;
    db.prepare('INSERT INTO activities VALUES(?,?,?,?,?,?,?,?)').run(next, at, 'say', '"Alice"', '"alice"', null, null,
      JSON.stringify({ mentions: ['Bob'], delivery: { mode: 'direct' }, metadata: { job: { id: 8 } } }));
    db.prepare('UPDATE square_meta SET next_act_index=?').run(next + 1);
    const index = Number(direct.id.slice(4)), payload = JSON.parse(db.prepare('SELECT payload_json FROM activities WHERE act_index=?').get(index).payload_json);
    payload.delivery = { mode: 'direct', preview: 'legacy preview' };
    db.prepare('UPDATE activities SET payload_json=? WHERE act_index=?').run(JSON.stringify(payload), index);
    legacyActivities(db, FORMAT8_SCHEMA_SQL);
    legacyAudience(db, FORMAT8_SCHEMA_SQL);
    db.exec('PRAGMA user_version=8;');
  });
  const preserved = inspect(input.path, db => Object.fromEntries(['receipts', 'delivery_evidence', 'delivery_cancellations', 'seats']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all().map(row => ({ ...row }))])));
  const before = digest(input.path);
  await assert.rejects(Square.at(input), error => error.facts?.reason === 'migration_required');
  assert.equal(digest(input.path), before, 'runtime refuses format 8 without writing');

  assert.equal((await migrateSquare({ ...input, env: { ...input.env, SQUARE_HOST_LEDGER_ROOT: '/not/a/legacy/ledger' } })).status, 'migrated');
  const after = inspect(input.path, db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    next: db.prepare('SELECT next_act_index FROM square_meta').get().next_act_index,
    activities: db.prepare('SELECT act_index,kind,payload_json FROM activities ORDER BY act_index').all()
      .map(row => ({ index: row.act_index, kind: row.kind, payload: JSON.parse(row.payload_json) })),
    audience: db.prepare('SELECT act_index,route,generation_json FROM landed_audience ORDER BY act_index,recipient_order').all()
      .map(row => ({ ...row })),
    preserved: Object.fromEntries(['receipts', 'delivery_evidence', 'delivery_cancellations', 'seats']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all().map(row => ({ ...row }))])),
  }));
  assert.equal(after.version, CURRENT_USER_VERSION);
  assert.equal(after.next, Number(metadataOnly.slice(4)) + 1);
  assert.deepEqual(after.preserved, preserved, 'receipts, evidence, cancellations and seats are untouched');
  const directRow = after.activities.find(row => row.index === Number(direct.id.slice(4)));
  assert.equal(directRow.kind, 'message');
  assert.deepEqual(directRow.payload, { body: 'legacy direct body', metadata: { job: { id: 7 } },
    to: ['Bob'], preview: 'legacy preview' });
  const nativeOnly = after.activities.find(row => row.index === Number(metadataOnly.slice(4)));
  assert.equal(nativeOnly.kind, 'message');
  assert.deepEqual(nativeOnly.payload, { body: '', to: ['Bob'], metadata: { job: { id: 8 } } },
    'legacy metadata-only direct content keeps its facts under an empty native body');
  assert.equal(after.activities.find(row => row.index === Number(agora.id.slice(4))).kind, 'say', 'ordinary Agora content stays say');
  const nativeAddresses = after.audience.filter(row => row.act_index === Number(direct.id.slice(4)) || row.act_index === Number(metadataOnly.slice(4)));
  assert.deepEqual(nativeAddresses.map(row => ({ route: row.route, generation: row.generation_json })), [
    { route: 'message', generation: null }, { route: 'message', generation: null },
  ], 'native messages survive a takeover because their addresses are unfenced');

  const artifact = createArtifactPort(input.path);
  try {
    const messages = await artifact.read(facts => [direct.id, metadataOnly].map(id => facts.activity(Number(id.slice(4)))));
    assert.equal(messages.value[0].body, 'legacy direct body');
    assert.equal(messages.value[1].body, '');
  } finally { await artifact.close(); }
});


test('format 8 native evidence accepts the frozen legacy frame bytes it actually sent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-format8-native-ack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const input = { path: path.join(root, 'native8.square'), env };
  const session = 'legacy-native-ack', endpoint = path.join(root, 'native.sock');
  const owner = harnessOwner({ channel: 'claude-code', session });
  const wakeAddress = { kind: 'claude-native', address: { sessionId: session, endpoint, loaded: 'true' } };
  const square = await Square.build({ ...input, markdown: 'format eight native fixture' });
  await square.join('Alice', { owner: 'test:alice' });
  await square.join('Bob', { owner, wakeAddress });
  const seat = (await square.artifact.read(facts => facts.seat('Bob'))).value;
  await square.close();
  await rememberSquarePath(input.path, owner, env.SQUARE_INDEX);

  const index = inspect(input.path, db => db.prepare('SELECT next_act_index FROM square_meta').get().next_act_index);
  const fullBody = 'legacy direct full body', preview = 'legacy direct preview…';
  const oldFrame = (actIndex, token, bodyText) => {
    const block = [`<channel-message channel="${input.path}" from="Alice" to="Bob" id="act/${actIndex}">`,
      bodyText, '</channel-message>'].join('\n');
    const reminder = ['', '<system-reminder>', 'This is an external notification, not a direct message from the user.', '',
      block, '</system-reminder>', ''].join('\n');
    return `[square-inbox:${token}]\n${reminder}\n[/square-inbox:${token}]`;
  };
  const fullToken = 'legacy-full', previewToken = 'legacy-preview';
  const frames = { full: oldFrame(index, fullToken, fullBody), preview: oldFrame(index + 1, previewToken, preview) };
  const hash = text => createHash('sha256').update(text).digest('hex');
  inspect(input.path, db => {
    const insert = db.prepare('INSERT INTO activities VALUES(?,?,?,?,?,?,?,?)');
    const at = Date.now();
    insert.run(index, at, 'say', '"Alice"', '"alice"', null, null,
      JSON.stringify({ body: fullBody, mentions: ['Bob'], delivery: { mode: 'direct' } }));
    insert.run(index + 1, at + 1, 'say', '"Alice"', '"alice"', null, null,
      JSON.stringify({ body: fullBody, mentions: ['Bob'], delivery: { mode: 'direct', preview } }));
    const evidence = db.prepare('INSERT INTO delivery_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const route = { kind: 'claude-native', address: { sessionId: session, endpoint, loaded: 'true' } };
    for (const [token, activity, payload] of [[fullToken, index, frames.full], [previewToken, index + 1, frames.preview]])
      evidence.run(JSON.stringify('bob'), '"Bob"', JSON.stringify(seat.generation), activity, 'wake', 0, 'accepted', at + 2, null,
        JSON.stringify(token), JSON.stringify({ route, correlation: { harness: 'claude', token, messageId: `legacy-${token}`, payloadHash: hash(payload) } }));
    db.prepare('UPDATE square_meta SET next_act_index=?').run(index + 2);
    legacyActivities(db, FORMAT8_SCHEMA_SQL);
    legacyAudience(db, FORMAT8_SCHEMA_SQL);
    db.exec('PRAGMA user_version=8;');
  });

  assert.equal((await migrateSquare(input)).status, 'migrated');
  assert.deepEqual(await observeClaudeDelivery(session, frames.full, 'guard', env), { recognized: true, current: true });
  assert.deepEqual(await observeClaudeDelivery(session, frames.full, 'admitted', env), { recognized: true, current: true });
  assert.deepEqual(await observeClaudeDelivery(session, frames.full, 'stored', env), { recognized: true, current: true });
  assert.deepEqual(await observeClaudeDelivery(session, frames.preview, 'stored', env), { recognized: true, current: true });
  const artifact = createArtifactPort(input.path);
  try {
    const facts = (await artifact.read(read => ({
      fullReceipt: read.receipt('Bob', index), previewReceipt: read.receipt('Bob', index + 1),
      fullEvidence: read.deliveryEvidence('Bob', seat.generation, `act/${index}`),
      previewEvidence: read.deliveryEvidence('Bob', seat.generation, `act/${index + 1}`),
      fullMessage: read.activity(index), previewMessage: read.activity(index + 1),
    }))).value;
    assert.deepEqual(facts.fullReceipt, { at: facts.fullReceipt.at }, 'a full legacy frame consumes the migrated body');
    assert.equal(facts.previewReceipt, undefined, 'a sender preview never consumes the full migrated body');
    assert.equal(facts.fullEvidence.find(row => row.kind === 'wake').outcome, 'accepted');
    assert.equal(facts.fullEvidence.find(row => row.kind === 'presentation').outcome, 'presented');
    assert.equal(facts.previewEvidence.find(row => row.kind === 'presentation').outcome, 'clipped');
    assert.equal(facts.fullMessage.kind, 'message');
    assert.equal(facts.fullMessage.body, fullBody);
    assert.equal(facts.previewMessage.preview, preview);
  } finally { await artifact.close(); }
});
