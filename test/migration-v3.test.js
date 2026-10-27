import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createArtifactPort } from '../dist/artifact.js';
import { observeClaudeDelivery, nativePayload } from '../dist/claude-delivery.js';
import { CURRENT_USER_VERSION } from '../dist/square-sqlite.js';
import { migrateSquareFile } from '../dist/square-migration.js';
import { rememberSquarePath } from '../dist/square-index.js';
import { renderAttentionPreview, renderSquareReminder } from '../dist/attention-presentation.js';
import { writeLegacyLedger } from './fixtures/legacy-host-ledger.js';

const CLAUDE_ENDPOINT = '/tmp/legacy-claude.sock';

// Historical wire bytes are not current memberships; render their legacy coordinates directly.
function legacyPreview(location, recipient, notification) {
  return renderSquareReminder([renderAttentionPreview({ squarePath: fs.realpathSync.native(location), recipient, ...notification })]);
}

function presenceRecord(location, participant, session, channel, updatedAt) {
  return { v: 1, location: fs.realpathSync.native(location), participant, session, channel, updatedAt };
}

function defaultRoutes() {
  return [
    { participant: 'Alice', session: 'alice-session', channel: 'codex', kind: 'paseo', address: { agentId: 'alice' } },
    { participant: 'Bob', session: 'bob-session', channel: 'claude-code', kind: 'claude-native', address: { endpoint: CLAUDE_ENDPOINT, loaded: 'true' } },
    { participant: 'Cara', session: 'cara-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'cara' } },
  ];
}

/** Alice's repeated registration proves the same owner/body may appear more than once. */
function defaultPresence(location, routes) {
  return routes.flatMap((route, position) => {
    const record = { ...presenceRecord(location, route.participant, route.session, route.channel, 1010 + position),
      ...(route.agent === undefined ? {} : { agent: route.agent }) };
    return route.participant === 'Alice'
      ? [{ ...record, updatedAt: 1009 }, { ...record, updatedAt: 1015 }]
      : [record];
  });
}

function fixture(t, { routes = defaultRoutes(), doneNative = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v3-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, 'PUBLIC.square');
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'host-ledger'), SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const sql = fs.readFileSync(new URL('./fixtures/v3-artifact.sql', import.meta.url), 'utf8');
  const database = new DatabaseSync(location);
  try {
    database.exec(sql);
    const insertRoute = database.prepare('INSERT INTO routes(position,participant_key_json,session_json,kind,updated_at,payload_json) VALUES(?,?,?,?,?,?)');
    routes.forEach((route, position) => insertRoute.run(position, JSON.stringify(route.participant.toLocaleLowerCase()),
      JSON.stringify(route.session), route.kind, 1010 + position, JSON.stringify({ location, participant: route.participant,
        channel: route.channel, address: route.address, extra: route.agent === undefined ? {} : { agent: route.agent }, epoch: 1 })));
    if (doneNative) {
      const insertActivity = database.prepare('INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json) VALUES(?,?,?,?,?,?,?,?)');
      insertActivity.run(8, 1016, 'join', '"Dana"', '"dana"', null, null, '{}');
      insertActivity.run(9, 1017, 'say', '"Alice"', '"alice"', null, null, '{"body":"dana, you here?","mentions":["Dana"]}');
      insertActivity.run(10, 1018, 'done', '"Dana"', '"dana"', null, null, '{}');
      database.prepare('INSERT INTO participants(name_key_json,name_json,first_index,joined,done,say_count,last_active_at,last_join_index) VALUES(?,?,?,?,?,?,?,?)')
        .run('"dana"', '"Dana"', 8, 0, 1, 0, 1018, 8);
      database.prepare('INSERT INTO landed_audience(act_index,recipient_key_json,recipient_order,route) VALUES(?,?,?,?)')
        .run(9, '"dana"', 0, 'mention');
      database.prepare("UPDATE participants SET say_count=3,last_active_at=1017 WHERE name_key_json='\"alice\"'").run();
      database.prepare('UPDATE square_meta SET revision=12,next_act_index=11 WHERE id=1').run();
    }
  } finally { database.close(); }
  return { root, location, env, routes, presence: defaultPresence(location, routes) };
}

function digest(location) { return crypto.createHash('sha256').update(fs.readFileSync(location)).digest('hex'); }
function ledgerDigest(env) { return digest(path.join(env.SQUARE_HOST_LEDGER_ROOT, 'host-ledger.sqlite')); }
function rows(location, sql) {
  const database = new DatabaseSync(location, { readOnly: true });
  try { return database.prepare(sql).all(); }
  finally { database.close(); }
}

function nativeRecord(location, token, messageId, preview, extra = {}) {
  const payload = nativePayload(token, preview);
  return {
    v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6', kind: 'wake', outcome: 'unknown',
    at: 1016, attemptN: 2, claimToken: token, routeKind: 'claude-native',
    nativeDelivery: { harness: 'claude', payload, epoch: 1, endpoint: CLAUDE_ENDPOINT, messageId },
    nativeObservations: [{ eventId: 'legacy-event', messageId, state: 'held', reason: 'no-mode-asserted', observedAt: 1016 }],
    ...extra,
  };
}

/** A refusal must leave both the square and the legacy ledger byte-for-byte untouched. */
function assertRefusedWithoutPublishing(location, env, before, ledgerBefore) {
  assert.equal(digest(location), before);
  assert.equal(ledgerDigest(env), ledgerBefore);
  assert.equal(rows(location, 'SELECT user_version FROM pragma_user_version')[0].user_version, 3);
  assert.equal(rows(location, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='routes'")[0].n, 1);
  assert.equal(rows(location, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='seats'")[0].n, 0);
}

test('format-3 conversion imports evidence as current Claude correlation and retains unlisten', async (t) => {
  const token = 'legacy-claude-token';
  const messageId = 'legacy-native-message';
  const { location, env, presence } = fixture(t);
  const preview = legacyPreview(location, 'Bob',
    { actIndex: 6, actor: 'Alice', at: 1014, route: 'attention', body: 'v3 pending attention' });
  const legacy = nativeRecord(location, token, messageId, preview);
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence);

  const before = digest(location);
  const oldActs = rows(location, 'SELECT act_index,kind,actor_json,payload_json FROM activities ORDER BY act_index');
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.status, 'migrated');
  assert.equal(rows(location, 'SELECT user_version FROM pragma_user_version')[0].user_version, CURRENT_USER_VERSION);
  assert.equal(rows(location, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='routes'")[0].n, 0);
  assert.deepEqual(rows(location, 'SELECT act_index,kind,actor_json,payload_json FROM activities ORDER BY act_index'), oldActs);
  assert.equal(oldActs.find((act) => act.act_index === 7).kind, 'unlisten');
  assert.notEqual(digest(location), before);

  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => ({
      seat: facts.seat('Bob'),
      evidence: facts.deliveryEvidence('Bob', 'act/1', 'act/6')[0],
      unlisten: facts.activity(7),
    }));
    assert.equal(value.seat.body.session, 'bob-session');
    assert.equal(value.seat.wakeAddress.kind, 'claude-native');
    assert.equal(value.seat.wakeAddress.address.sessionId, 'bob-session');
    assert.deepEqual(value.evidence.correlation, {
      harness: 'claude', token, messageId, payloadHash: crypto.createHash('sha256').update(legacy.nativeDelivery.payload).digest('hex'),
    });
    assert.equal(value.evidence.nativeObservations, undefined);
    assert.deepEqual(value.evidence.route, { kind: 'claude-native', address: { endpoint: CLAUDE_ENDPOINT, loaded: 'true', sessionId: 'bob-session' } });
    assert.equal(value.unlisten.kind, 'unlisten');
  } finally { await artifact.close(); }

  const stored = rows(location, "SELECT payload_json FROM delivery_evidence WHERE participant_key_json='\"bob\"' AND act_index=6");
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(stored[0].payload_json)).sort(), ['correlation', 'route']);

  await rememberSquarePath(location, { channel: 'claude-code', session: 'bob-session' }, env.SQUARE_INDEX);
  const observed = await observeClaudeDelivery('bob-session', legacy.nativeDelivery.payload, 'guard', env);
  assert.deepEqual(observed, { recognized: true, current: true });

  const ledger = new DatabaseSync(path.join(env.SQUARE_HOST_LEDGER_ROOT, 'host-ledger.sqlite'));
  try {
    ledger.prepare('INSERT INTO host_native_tokens VALUES(?,?,?)').run('claude', JSON.stringify('bob-session'), JSON.stringify('retired-token'));
  } finally { ledger.close(); }
  const currentBytes = digest(location), ledgerBytes = ledgerDigest(env);
  assert.deepEqual(await migrateSquareFile(location, undefined, env), { status: 'already-current', standing: 3 });
  assert.equal(digest(location), currentBytes, 'already-current artifacts do not consult or rewrite a legacy ledger');
  assert.equal(ledgerDigest(env), ledgerBytes);
});

test('format-3 migration refuses ledger-wide token tombstones without altering either source', async t => {
  const { location, env, presence } = fixture(t);
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], presence);
  const ledger = new DatabaseSync(path.join(env.SQUARE_HOST_LEDGER_ROOT, 'host-ledger.sqlite'));
  try {
    // No artifact/participant/activity coordinate exists, even for an unrelated session.
    ledger.prepare('INSERT INTO host_native_tokens VALUES(?,?,?)').run('claude', JSON.stringify('unrelated-session'), JSON.stringify('orphan-token'));
  } finally { ledger.close(); }
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /native token tombstones cannot be mapped safely/);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 migration selects the latest owner by effectiveAt then seq without a retention window', async (t) => {
  const { location, env, presence } = fixture(t);
  // The route Body is the second row at the newest effectiveAt; a later-seq row has an older
  // effectiveAt, so only (effectiveAt, seq) ordering picks the matching owner.
  const custom = [
    ...presence.filter((row) => row.participant !== 'Bob'),
    presenceRecord(location, 'Bob', 'bob-stale', 'claude-code', 1010),
    presenceRecord(location, 'Bob', 'bob-stale', 'claude-code', 1012),
    presenceRecord(location, 'Bob', 'bob-session', 'claude-code', 1012),
    presenceRecord(location, 'Bob', 'bob-stale', 'claude-code', 1011),
  ];
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], custom);

  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.status, 'migrated');
  assert.equal(result.standing, 3);

  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => ({
      bob: facts.seat('Bob'),
      stale: facts.seatsForBody({ channel: 'claude-code', session: 'bob-stale' }),
    }));
    assert.deepEqual(value.bob.body, { channel: 'claude-code', session: 'bob-session' });
    assert.equal(value.bob.generation, 'act/1');
    assert.deepEqual(value.stale, []);
  } finally { await artifact.close(); }
});

test('format-3 migration refuses a standing participant with no current legacy owner', async (t) => {
  const { location, env, presence } = fixture(t);
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], presence.filter((row) => row.participant !== 'Bob'));
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /owner|presence|body|route|evidence/i);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 migration refuses an owner Body that disagrees with the route Body', async (t) => {
  const { location, env, presence } = fixture(t);
  const custom = [
    ...presence.filter((row) => row.participant !== 'Bob'),
    presenceRecord(location, 'Bob', 'bob-other-session', 'claude-code', 1015),
  ];
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], custom);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /owner|route|body|presence/i);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 migration refuses a route Body shared by two owners', async (t) => {
  const routes = defaultRoutes();
  routes[0] = { ...routes[0], channel: 'paseo', session: 'shared-session' };
  routes[2] = { ...routes[2], channel: 'paseo', session: 'shared-session' };
  const { location, env, presence } = fixture(t, { routes });
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], presence);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /shared|owner|route|body/i);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 migration keeps only retired Claude correlation for a done participant', async (t) => {
  const token = 'retired-claude-token';
  const messageId = 'retired-native-message';
  const { location, env, presence } = fixture(t, { doneNative: true });
  const preview = legacyPreview(location, 'Dana',
    { actIndex: 9, actor: 'Alice', at: 1017, route: 'mention', body: 'dana, you here?' });
  const legacy = nativeRecord(location, token, messageId, preview, {
    participant: 'Dana', session: 'dana-session', activity: 'act/9', at: 1017,
    signature: 'legacy-signature', message: 'legacy message', diagnostic: { reason: 'legacy' }, legacyNote: 'drop me',
  });
  const dropped = { v: 1, location, participant: 'Dana', session: 'dana-session', activity: 'act/9', kind: 'presentation', outcome: 'presented', at: 1017, claimToken: 'dropped-claude-token' };
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy, dropped], presence);

  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.status, 'migrated');
  assert.equal(result.standing, 3);

  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => ({
      seat: facts.seat('Dana'),
      completed: facts.completedSeatsForBody({ channel: 'claude-code', session: 'dana-session' }),
      evidence: facts.deliveryEvidence('Dana', 'act/8', 'act/9'),
      receipt: facts.receipt('Dana', 9),
      dropped: facts.deliveryByToken('dropped-claude-token'),
    }));
    assert.equal(value.seat, undefined);
    assert.deepEqual(value.completed, []);
    assert.equal(value.receipt, undefined);
    assert.equal(value.dropped, undefined);
    assert.equal(value.evidence.length, 1);
    const [evidence] = value.evidence;
    assert.equal(evidence.kind, 'wake');
    assert.equal(evidence.generation, 'act/8');
    assert.equal(evidence.activity, 'act/9');
    assert.deepEqual(evidence.correlation, {
      harness: 'claude', token, messageId, payloadHash: crypto.createHash('sha256').update(legacy.nativeDelivery.payload).digest('hex'),
    });
    assert.deepEqual(evidence.route, { kind: 'claude-native', address: { endpoint: CLAUDE_ENDPOINT, loaded: 'true', sessionId: 'dana-session' } });
  } finally { await artifact.close(); }

  const stored = rows(location, "SELECT payload_json FROM delivery_evidence WHERE participant_key_json='\"dana\"'");
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(stored[0].payload_json)).sort(), ['correlation', 'route']);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM seats')[0].n, 3);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM receipts')[0].n, 1);

  await rememberSquarePath(location, { channel: 'claude-code', session: 'dana-session' }, env.SQUARE_INDEX);
  const beforeObservation = rows(location, 'SELECT * FROM delivery_evidence ORDER BY participant_key_json,act_index,attempt_n');
  for (const operation of ['guard', 'admitted', 'stored']) {
    assert.deepEqual(await observeClaudeDelivery('dana-session', legacy.nativeDelivery.payload, operation, env),
      { recognized: true, current: false });
    assert.deepEqual(rows(location, 'SELECT * FROM delivery_evidence ORDER BY participant_key_json,act_index,attempt_n'), beforeObservation);
  }
  assert.equal(rows(location, "SELECT COUNT(*) AS n FROM receipts WHERE owner_json='\"dana\"'")[0].n, 0);
});

test('format-3 migration refuses a done native correlation outside the verified generation', async (t) => {
  const { location, env, presence } = fixture(t, { doneNative: true });
  const preview = legacyPreview(location, 'Dana',
    { actIndex: 9, actor: 'Alice', at: 1017, route: 'mention', body: 'dana, you here?' });
  const legacy = nativeRecord(location, 'retired-claude-token', 'retired-native-message', preview, {
    participant: 'Dana', session: 'dana-session', activity: 'act/6', at: 1014,
  });
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /generation|activity|ambiguous|owner|done|direct|evidence/i);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 migration refuses native evidence for an unknown participant', async (t) => {
  const { location, env, presence } = fixture(t);
  const preview = legacyPreview(location, 'Bob',
    { actIndex: 6, actor: 'Alice', at: 1014, route: 'attention', body: 'v3 pending attention' });
  const legacy = nativeRecord(location, 'ghost-token', 'ghost-message', preview, {
    participant: 'Ghost', session: 'ghost-session', activity: 'act/6', at: 1016,
  });
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /participant|owner|join|ambiguous|unknown|evidence/i);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 migration refuses a done native correlation without a verified join', async (t) => {
  const { location, env, presence } = fixture(t, { doneNative: true });
  const database = new DatabaseSync(location);
  try { database.prepare("UPDATE participants SET last_join_index=9 WHERE name_key_json='\"dana\"'").run(); }
  finally { database.close(); }
  const preview = legacyPreview(location, 'Dana',
    { actIndex: 9, actor: 'Alice', at: 1017, route: 'mention', body: 'dana, you here?' });
  const legacy = nativeRecord(location, 'retired-claude-token', 'retired-native-message', preview, {
    participant: 'Dana', session: 'dana-session', activity: 'act/9', at: 1017,
  });
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /join|participant|ambiguous|verif|last/i);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('standing migration preserves a known agent and refuses top-level evidence for that child body', async t => {
  const routes = defaultRoutes();
  routes[1] = { ...routes[1], agent: 'child' };
  const { location, env, presence } = fixture(t, { routes });
  const legacy = { v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6',
    kind: 'wake', outcome: 'unknown', at: 1016, claimToken: 'top-level-token' };
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /no unique owner/);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
  const ledger = new DatabaseSync(path.join(env.SQUARE_HOST_LEDGER_ROOT, 'host-ledger.sqlite'));
  try {
    const stored = JSON.parse(ledger.prepare('SELECT row_json FROM host_evidence').get().row_json);
    ledger.prepare('UPDATE host_evidence SET row_json=?').run(JSON.stringify({ ...stored, agent: 'child' }));
  } finally { ledger.close(); }
  assert.equal((await migrateSquareFile(location, undefined, env)).status, 'migrated');
  const artifact = createArtifactPort(location);
  try {
    assert.deepEqual((await artifact.read(facts => facts.seat('Bob').body)).value,
      { channel: 'claude-code', session: 'bob-session', agent: 'child' });
  } finally { await artifact.close(); }
});

test('standing migration refuses evidence from before the current last join', async t => {
  const { location, env, presence } = fixture(t);
  const database = new DatabaseSync(location);
  try {
    database.exec(`
      INSERT INTO activities VALUES(8,1016,'done','"Bob"','"bob"',NULL,NULL,'{}');
      INSERT INTO activities VALUES(9,1017,'join','"Bob"','"bob"',NULL,NULL,'{}');
      UPDATE participants SET last_join_index=9,last_active_at=1017 WHERE name_key_json='"bob"';
      UPDATE square_meta SET revision=11,next_act_index=10;
    `);
  } finally { database.close(); }
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [{ v: 1, location, participant: 'Bob', session: 'bob-session',
    activity: 'act/6', kind: 'wake', outcome: 'unknown', at: 1016, claimToken: 'old-generation-token' }], presence);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /join generation/);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 migration refuses ambiguous imported attempt ordering without publishing', async (t) => {
  const { location, env, presence } = fixture(t);
  const records = [
    { v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6', kind: 'wake', outcome: 'unknown', at: 1016, claimToken: 'token-a' },
    { v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6', kind: 'wake', outcome: 'unknown', at: 1017, claimToken: 'token-b' },
  ];
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, records, presence);
  const before = digest(location), ledgerBefore = ledgerDigest(env);
  await assert.rejects(migrateSquareFile(location, undefined, env), /ambiguous/);
  assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
});

test('format-3 conversion rolls back all publication after a transactional failure', async (t) => {
  const { location, env, presence } = fixture(t);
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], presence);
  const before = digest(location);
  const realExec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (fs.realpathSync.native(this.location()) === fs.realpathSync.native(location) && String(sql).startsWith('DROP TABLE routes'))
      throw new Error('injected format-3 conversion failure');
    return realExec.call(this, sql, ...args);
  });
  await assert.rejects(migrateSquareFile(location, undefined, env), /injected format-3 conversion failure/);
  assert.equal(digest(location), before);
  assert.equal(rows(location, 'SELECT user_version FROM pragma_user_version')[0].user_version, 3);
  assert.equal(rows(location, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='routes'")[0].n, 1);
  assert.equal(rows(location, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='seats'")[0].n, 0);
});
