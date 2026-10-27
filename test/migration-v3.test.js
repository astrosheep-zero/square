import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { createArtifactPort, diagnoseSquareFile } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';
import { deliverPending, sweepPending } from '../dist/delivery-operations.js';
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

test('format-3 conversion imports route-derived Claude correlation and retains unlisten', async (t) => {
  const token = 'legacy-claude-token';
  const messageId = 'legacy-native-message';
  const { location, env, presence } = fixture(t);
  const preview = legacyPreview(location, 'Bob',
    { actIndex: 6, actor: 'Alice', at: 1014, route: 'attention', body: 'v3 pending attention' });
  const legacy = nativeRecord(location, token, messageId, preview);
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence.filter(row => row.participant !== 'Bob'));
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

test('format-3 migration preserves shared seats and leaves missing or conflicting ownership inert', async (t) => {
  const routes = defaultRoutes().filter(route => route.participant !== 'Bob');
  routes[1] = { ...routes[1], channel: routes[0].channel, session: routes[0].session };
  routes.push(
    { participant: 'Dana', session: 'dana-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'dana' } },
    { participant: 'Eve', session: 'eve-route', channel: 'codex', kind: 'paseo', address: { agentId: 'eve' } },
    { participant: 'Finn', session: 'finn-one', channel: 'codex', kind: 'paseo', address: { agentId: 'finn' } },
    { participant: 'Finn', session: 'finn-two', channel: 'codex', kind: 'paseo', address: { agentId: 'finn' } },
  );
  const { location, env, presence } = fixture(t, { routes });
  const database = new DatabaseSync(location);
  try {
    // Unowned Bob retains outgoing listen and ignore, an existing receipt and a catch lease.
    database.exec(`
      INSERT INTO activities VALUES(8,1016,'listen','"Bob"','"bob"',NULL,NULL,'{"target":"Alice"}');
      INSERT INTO activities VALUES(9,1017,'ignore','"Bob"','"bob"',NULL,NULL,'{"target":"Cara"}');
      INSERT INTO attention VALUES('"bob"','"alice"','"Alice"','listen',8);
      INSERT INTO attention VALUES('"bob"','"cara"','"Cara"','ignore',9);
      UPDATE participants SET last_active_at=1017 WHERE name_key_json='"bob"';
      INSERT INTO activities VALUES(10,1018,'join','"Dana"','"dana"',NULL,NULL,'{}');
      INSERT INTO participants VALUES('"dana"','"Dana"',10,1,0,0,1018,10);
      INSERT INTO activities VALUES(11,1019,'join','"Eve"','"eve"',NULL,NULL,'{}');
      INSERT INTO participants VALUES('"eve"','"Eve"',11,1,0,0,1019,11);
      INSERT INTO activities VALUES(12,1020,'join','"Finn"','"finn"',NULL,NULL,'{}');
      INSERT INTO participants VALUES('"finn"','"Finn"',12,1,0,0,1020,12);
      INSERT INTO activities VALUES(13,1021,'say','"Alice"','"alice"',NULL,NULL,'{"body":"Dana, you here?","mentions":["Dana"]}');
      INSERT INTO landed_audience VALUES(13,'"dana"',0,'mention');
      INSERT INTO landed_audience VALUES(13,'"bob"',1,'attention');
      UPDATE participants SET say_count=3,last_active_at=1021 WHERE name_key_json='"alice"';
      UPDATE square_meta SET next_act_index=14,revision=15;
    `);
  } finally { database.close(); }
  const records = [
    nativeRecord(location, 'unowned-token', 'unowned-message', 'legacy preview'),
    { v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6', kind: 'presentation', outcome: 'presented', at: 1016 },
    nativeRecord(location, 'mismatch-token', 'mismatch-message', 'legacy preview', { participant: 'Eve', session: 'eve-owner' }),
    nativeRecord(location, 'conflicting-token', 'conflicting-message', 'legacy preview', { participant: 'Finn', session: 'finn-one' }),
    { v: 1, location, participant: 'Dana', session: 'obsolete-dana', activity: 'act/13', kind: 'wake', outcome: 'unknown', at: 1021 },
    { v: 1, location, participant: 'Dana', session: 'dana-session', activity: 'act/13', kind: 'presentation', outcome: 'presented', at: 1021 },
  ];
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, records, [
    ...presence.filter(row => row.participant === 'Alice'),
    presenceRecord(location, 'Eve', 'eve-owner', 'codex', 1020),
  ]);
  const ledgerBefore = ledgerDigest(env);
  const before = Object.fromEntries(['activities', 'participants', 'landed_audience', 'receipts', 'attention']
    .map(table => [table, rows(location, `SELECT * FROM ${table} ORDER BY 1,2`)]));

  const leaseBefore = rows(location, 'SELECT owner_json,lease_id_json,heartbeat_at,expires_at,filter_json FROM catch_leases');
  const result = await migrateSquareFile(location, undefined, env);
  assert.deepEqual(result, { status: 'migrated', standing: 6, counts: {
    activities: 14, receipts: 1, leases: 1, routes: 6, recoveredSeats: 3, unownedStanding: 3, sharedBodySeats: 2, skippedEvidence: 5,
  } });
  for (const [table, original] of Object.entries(before)) {
    assert.deepEqual(rows(location, `SELECT * FROM ${table} ORDER BY 1,2`), original, `${table} is unchanged`);
  }
  assert.deepEqual(rows(location, 'SELECT owner_json,lease_id_json,heartbeat_at,expires_at,filter_json FROM catch_leases'), leaseBefore);
  assert.equal(rows(location, 'SELECT next_act_index FROM square_meta')[0].next_act_index, 14);
  assert.equal(rows(location, 'SELECT revision FROM square_meta')[0].revision, 15);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM delivery_evidence')[0].n, 1);
  assert.equal(ledgerDigest(env), ledgerBefore);

  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => ({
      alice: facts.seat('Alice'), cara: facts.seat('Cara'), dana: facts.seat('Dana'), bob: facts.seat('Bob'),
      eve: facts.seat('Eve'), finn: facts.seat('Finn'),
      sharedSeats: facts.seatsForBody({ channel: 'codex', session: 'alice-session' }),
      evidence: facts.deliveryEvidence('Bob', 'act/1', 'act/6'),
      danaEvidence: facts.deliveryEvidence('Dana', 'act/10', 'act/13'),
      pending: facts.directedAt('Bob', 6),
    }));
    assert.deepEqual(value.alice.body, { channel: 'codex', session: 'alice-session' });
    assert.equal(value.alice.generation, 'act/0');
    assert.deepEqual(value.cara.body, value.alice.body);
    assert.equal(value.cara.generation, 'act/2');
    assert.equal(value.alice.wakeAddress.address.agentId, 'alice');
    assert.equal(value.cara.wakeAddress.address.agentId, 'cara');
    assert.deepEqual(value.sharedSeats.map(seat => seat.participant).sort(), ['Alice', 'Cara']);
    assert.deepEqual(value.dana.body, { channel: 'paseo', session: 'dana-session' });
    assert.equal(value.dana.generation, 'act/10');
    assert.equal(value.bob, undefined);
    assert.equal(value.eve, undefined, 'owner/route disagreement grants neither side a seat');
    assert.equal(value.finn, undefined, 'conflicting routes grant neither side a seat');
    assert.deepEqual(value.evidence, [], 'unowned native and presentation evidence is skipped, not completed');
    assert.deepEqual(value.danaEvidence.map(row => row.kind), ['presentation'], 'seat-session mismatch is skipped but agreeing evidence is imported');
    assert.equal(value.pending.recipient, 'Bob', 'the unowned name still has historical unread attention');
    assert.deepEqual(await sweepPending({ artifact, location, now: 3000, graceMs: 0, limit: 10 }), [13]);
    assert.deepEqual(await deliverPending({ artifact, location, activity: 'act/6', now: 3000,
      transport: { async attempt() { assert.fail('unowned standing names cannot receive a delivery'); } },
    }), { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 0 });
  } finally { await artifact.close(); }
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 6 });
  const square = await Square.at({ path: location, env, body: { channel: 'test', session: 'not-an-owner' } });
  try {
    assert.equal((await square.status()).activeCount, 6);
    assert.equal((await square.participants()).participants.find(participant => participant.name === 'Bob').state, 'active');
    assert.equal((await square.history({ limit: null })).activities.length, 14);
    await assert.rejects((await square.participant('Bob')).done(), error => error.code === 'already_joined');
  } finally { await square.close(); }
  const current = digest(location);
  assert.deepEqual(await migrateSquareFile(location, undefined, env), { status: 'already-current', standing: 6 });
  assert.equal(digest(location), current);
});

test('format-3 migration without a ledger recovers one body with different wake addresses', async t => {
  const routes = defaultRoutes();
  routes.push({ ...routes[0], address: { agentId: 'another-alice-address' } });
  const { location, env } = fixture(t, { routes });
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.recoveredSeats, 3);
  assert.equal(result.counts.unownedStanding, 0);
  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => facts.seat('Alice'));
    assert.deepEqual(value.body, { channel: 'codex', session: 'alice-session' });
    assert.equal(value.wakeAddress, undefined, 'one body with different addresses keeps its seat without a wake address');
  } finally { await artifact.close(); }
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
});

test('format-3 migration leaves a name with conflicting routes unowned, with or without a ledger owner', async t => {
  for (const hasOwner of [false, true]) {
    const routes = defaultRoutes();
    routes.push({ ...routes[1], session: 'bob-other-session' });
    const { location, env, presence } = fixture(t, { routes });
    writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT,
      [nativeRecord(location, 'unowned-token', 'unowned-message', 'legacy preview')],
      hasOwner ? presence.filter(row => row.participant === 'Bob').slice(0, 1) : []);
    const before = rows(location, 'SELECT * FROM participants ORDER BY 1');
    const result = await migrateSquareFile(location, undefined, env);
    assert.equal(result.counts.recoveredSeats, 2);
    assert.equal(result.counts.unownedStanding, 1);
    assert.equal(result.counts.sharedBodySeats, 0);
    assert.deepEqual(rows(location, 'SELECT * FROM participants ORDER BY 1'), before);
    assert.equal(rows(location, `SELECT COUNT(*) AS n FROM seats WHERE participant_key_json='"bob"'`)[0].n, 0);
    assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM delivery_evidence')[0].n, 0);
    assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
  }
});

test('format-3 migration keeps every shared-body name whether or not another sharer has a ledger owner', async t => {
  for (const otherHasOwner of [false, true]) {
    const routes = defaultRoutes();
    routes[0] = { ...routes[0], channel: routes[1].channel, session: routes[1].session };
    const { location, env, presence } = fixture(t, { routes });
    writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], otherHasOwner ? presence.filter(row => row.participant === 'Alice') : []);
    const result = await migrateSquareFile(location, undefined, env);
    assert.equal(result.counts.recoveredSeats, 3);
    assert.equal(result.counts.unownedStanding, 0);
    assert.equal(result.counts.sharedBodySeats, 2);
    assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
  }
});

test('format-3 CLI reports all four counts from a large disposable ownership fixture', async t => {
  // Disposable evidence categories, not a copy of the live artifact. Body groups
  // are synthetic; seven disagreements fall inside one shared group.
  const bodyNumber = ordinal => ordinal < 204 ? Math.floor(ordinal / 12) : ordinal < 219 ? 17 : ordinal - 201;
  const routes = ['Alice', 'Bob'].map(participant => ({ participant, session: 'body-0', channel: 'codex', kind: 'paseo', address: { agentId: participant } }));
  const { location, env, presence } = fixture(t, { routes });
  const owners = presence.filter(row => row.participant === 'Alice');
  const database = new DatabaseSync(location);
  try {
    const join = database.prepare('INSERT INTO activities VALUES(?,?,?,?,?,NULL,NULL,?)');
    const participant = database.prepare('INSERT INTO participants VALUES(?,?,?,1,0,0,?,?)');
    const route = database.prepare('INSERT INTO routes VALUES(?,?,?,?,?,?)');
    // 3 agreeing owners + 657 route-only + 5 owner mismatches + 5 conflicting routes
    // + 417 names without evidence = 1087 standing names.
    for (let i = 0; i < 1084; i++) {
      const name = `Participant-${i}`, index = 8 + i, at = 2000 + i;
      join.run(index, at, 'join', JSON.stringify(name), JSON.stringify(name.toLowerCase()), '{}');
      participant.run(JSON.stringify(name.toLowerCase()), JSON.stringify(name), index, at, index);
      if (i < 668) {
        const session = `body-${bodyNumber(i + 2)}`;
        route.run(2 + i, JSON.stringify(name.toLowerCase()), JSON.stringify(session), 'paseo', at,
          JSON.stringify({ location, participant: name, channel: 'codex', address: { agentId: name }, extra: {} }));
        if (i < 9) owners.push(presenceRecord(location, name, i >= 2 && i <= 6 ? `owner-${name}` : session, 'codex', at));
        if (i === 7 || i === 8 || i >= 665) {
          route.run(2000 + i, JSON.stringify(name.toLowerCase()), JSON.stringify(`conflicting-${name}`), 'paseo', at,
            JSON.stringify({ location, participant: name, channel: 'codex', address: { agentId: name }, extra: {} }));
        }
      }
    }
    database.prepare('UPDATE square_meta SET next_act_index=1092,revision=1093').run();
  } finally { database.close(); }
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [
    { v: 1, location, participant: 'Bob', session: 'obsolete-body', activity: 'act/6', kind: 'wake', outcome: 'unknown', at: 1016 },
  ], owners);
  const output = execFileSync(process.execPath, ['dist/square.js', '--location', location, 'migrate'], { env, encoding: 'utf8' });
  assert.match(output, /660 recovered seats · 427 unowned standing · 212 shared-body seats · 1 skipped evidence/);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM seats')[0].n, 660);
  assert.equal(rows(location, 'SELECT COUNT(DISTINCT session_json) AS n FROM seats')[0].n, 466);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM participants WHERE joined=1 AND done=0')[0].n, 1087);
  assert.equal(rows(location, "SELECT COUNT(*) AS n FROM activities WHERE kind='done'")[0].n, 0);
  assert.equal(rows(location, 'SELECT next_act_index FROM square_meta')[0].next_act_index, 1092);
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 1087 });
  execFileSync(process.execPath, ['dist/square.js', '--location', location, 'doctor'], { env, encoding: 'utf8' });
});

test('format-3 routes remain location-bound when a disposable artifact is copied elsewhere', async t => {
  const { root, location, env } = fixture(t);
  const original = digest(location);
  const copy = path.join(root, 'COPY.square');
  fs.copyFileSync(location, copy);
  const result = await migrateSquareFile(copy, undefined, env);
  assert.equal(result.standing, 3);
  assert.equal(result.counts.recoveredSeats, 0);
  assert.equal(result.counts.unownedStanding, 3);
  assert.equal(result.counts.sharedBodySeats, 0);
  assert.deepEqual(await diagnoseSquareFile(copy), { problems: [], standingCount: 3 });
  assert.equal(digest(location), original, 'the source fixture is untouched');
});

test('format-3 migration preserves both ledger-backed names sharing a body', async (t) => {
  const routes = defaultRoutes();
  routes[0] = { ...routes[0], channel: 'paseo', session: 'shared-session' };
  routes[2] = { ...routes[2], channel: 'paseo', session: 'shared-session' };
  const { location, env, presence } = fixture(t, { routes });
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], presence);
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.recoveredSeats, 3);
  assert.equal(result.counts.unownedStanding, 0);
  assert.equal(result.counts.sharedBodySeats, 2);
  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => facts.seatsForBody({ channel: 'paseo', session: 'shared-session' }));
    assert.deepEqual(value.map(seat => [seat.participant, seat.generation]).sort(), [['Alice', 'act/0'], ['Cara', 'act/2']]);
  } finally { await artifact.close(); }
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
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
  assert.equal(result.counts.skippedEvidence, 1, 'completed non-native diagnostics count as skipped');

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

test('format-3 migration skips a done native correlation outside the verified generation', async (t) => {
  const { location, env, presence } = fixture(t, { doneNative: true });
  const preview = legacyPreview(location, 'Dana',
    { actIndex: 9, actor: 'Alice', at: 1017, route: 'mention', body: 'dana, you here?' });
  const legacy = nativeRecord(location, 'retired-claude-token', 'retired-native-message', preview, {
    participant: 'Dana', session: 'dana-session', activity: 'act/6', at: 1014,
  });
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence);
  const ledgerBefore = ledgerDigest(env);
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.skippedEvidence, 1);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM delivery_evidence')[0].n, 0);
  assert.equal(ledgerDigest(env), ledgerBefore);
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
});

test('format-3 migration skips native evidence for an unknown participant', async (t) => {
  const { location, env, presence } = fixture(t);
  const preview = legacyPreview(location, 'Bob',
    { actIndex: 6, actor: 'Alice', at: 1014, route: 'attention', body: 'v3 pending attention' });
  const legacy = nativeRecord(location, 'ghost-token', 'ghost-message', preview, {
    participant: 'Ghost', session: 'ghost-session', activity: 'act/6', at: 1016,
  });
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [legacy], presence);
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.skippedEvidence, 1);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM delivery_evidence')[0].n, 0);
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
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

test('standing migration preserves a known agent and skips evidence for a different agent', async t => {
  const routes = defaultRoutes();
  routes[1] = { ...routes[1], agent: 'child' };
  const { location, env, presence } = fixture(t, { routes });
  const legacy = { v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6',
    kind: 'wake', outcome: 'unknown', at: 1016, claimToken: 'top-level-token' };
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [
    legacy,
    { ...legacy, agent: 'child', channel: 'codex', claimToken: 'wrong-channel-token' },
    { ...legacy, agent: 'child', claimToken: 'wrong-harness-token', nativeDelivery: { harness: 'opencode', inputId: 'legacy-input', payload: 'legacy preview' } },
    { ...legacy, agent: 'child', claimToken: 'child-token' },
  ], presence);
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.skippedEvidence, 3);
  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => ({ body: facts.seat('Bob').body, evidence: facts.deliveryEvidence('Bob', 'act/1', 'act/6') }));
    assert.deepEqual(value.body, { channel: 'claude-code', session: 'bob-session', agent: 'child' });
    assert.deepEqual(value.evidence.map(row => row.claimToken), ['child-token']);
  } finally { await artifact.close(); }
});

test('standing migration skips evidence from before the current last join', async t => {
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
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.skippedEvidence, 1);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM delivery_evidence')[0].n, 0);
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
});

test('format-3 migration skips all evidence in ambiguous attempt or claim-token mappings', async (t) => {
  for (const ambiguity of ['missing-attempts', 'duplicate-attempts', 'duplicate-token']) {
    const { location, env, presence } = fixture(t);
    const records = [
      { v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6', kind: 'wake', outcome: 'unknown', at: 1016, claimToken: 'token-a' },
      { v: 1, location, participant: 'Bob', session: 'bob-session', activity: 'act/6', kind: 'wake', outcome: 'unknown', at: 1017, claimToken: 'token-b' },
    ];
    if (ambiguity === 'duplicate-attempts') records.forEach(row => { row.attemptN = 1; });
    if (ambiguity === 'duplicate-token') {
      records[1].activity = 'act/5';
      records[1].claimToken = records[0].claimToken;
    }
    writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, records, presence);
    const result = await migrateSquareFile(location, undefined, env);
    assert.equal(result.counts.skippedEvidence, 2, ambiguity);
    assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM delivery_evidence')[0].n, 0);
    assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
  }
});

test('format-3 migration skips every ambiguous completed-body mapping rather than selecting one', async t => {
  const { location, env, presence } = fixture(t, { doneNative: true });
  const records = ['one', 'two'].map(session => nativeRecord(location, `retired-${session}`, `message-${session}`, 'legacy preview', {
    participant: 'Dana', session, activity: 'act/9',
  }));
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, records, presence);
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.skippedEvidence, 2);
  assert.equal(rows(location, 'SELECT COUNT(*) AS n FROM delivery_evidence')[0].n, 0);
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
});

test('format-3 migration refuses structurally malformed evidence even for an unowned name without writing', async t => {
  for (const extra of [
    { nativeDelivery: { harness: 'claude', payload: '', endpoint: CLAUDE_ENDPOINT } },
    { activity: 'act/not-an-index' },
    { outcome: 'unsupported' },
    { agent: 42 },
    { attemptN: -1 },
  ]) {
    const { location, env, presence } = fixture(t, { routes: defaultRoutes().filter(route => route.participant !== 'Bob') });
    writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [nativeRecord(location, 'malformed-token', 'message', 'legacy preview', extra)], presence);
    const before = digest(location), ledgerBefore = ledgerDigest(env);
    await assert.rejects(migrateSquareFile(location, undefined, env), /malformed|unsupported/);
    assertRefusedWithoutPublishing(location, env, before, ledgerBefore);
  }
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
