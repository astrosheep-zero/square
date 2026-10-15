// Explicit atomic migration from v1 snapshots to v2 rows.
//
// The fixture half runs against the frozen v1 writer in test/fixtures and needs
// no v2 code. The migration half is gated on the row-backed runtime landing in
// this worktree: until then those tests skip with the dependency named, and V2
// flips by itself once dist/square-sqlite.js exists. Do not delete the gate
// without running every gated test.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  fixtureDirectory, legacyFixtureState, nonFiniteRouteText, readV1SnapshotRow, readV1State,
  v1Framing, V1_APPLICATION_ID, V1_SNAPSHOT_DDL, writeRawSqlite, writeV1Artifact, writeV1ArtifactText,
} from './fixtures/v1-artifact.js';
import { run, runAsync, testEnv } from './square-cli-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'square.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const PINNED_V1_ROOT = process.env.SQUARE_V1_PINNED_ROOT ?? '/opt/homebrew/lib/node_modules/@astrosheep/square';
const PINNED_V1_CLI = path.join(PINNED_V1_ROOT, 'dist', 'square.js');

const V2 = fs.existsSync(path.join(ROOT, 'dist', 'square-sqlite.js'));
const MIGRATION = V2 && fs.existsSync(path.join(ROOT, 'dist', 'square-migration.js'));
const GATE = 'awaits kei/replace-whole-state-runtime-with-de1c';
const MIGRATION_GATE = V2 ? 'awaits the explicit migrate command in this worktree' : GATE;
// The differential oracle belongs to the runtime delivery's test fixtures.
const ORACLE = path.join(ROOT, 'test', 'fixtures', 'legacy-square-core.js');
const hasPinnedV1 = fs.existsSync(PINNED_V1_CLI);
const PINNED_GATE = `awaits a pinned shipped v1 runtime at ${PINNED_V1_ROOT}`;
const gate = (ok, reason) => (ok ? false : reason);

function normalizeSql(sql) {
  return sql.trim().replace(/\s+/g, ' ').replace(/\s*(>=|[(),=])\s*/g, '$1');
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function openRaw(squarePath) {
  const uri = pathToFileURL(path.resolve(squarePath));
  uri.searchParams.set('mode', 'rw');
  return new DatabaseSync(uri.href);
}

async function openV2(squarePath) {
  const { createSqliteDriver, exportSqliteState } = await import(pathToFileURL(path.join(ROOT, 'dist', 'square-sqlite.js')).href);
  const database = openRaw(squarePath);
  return { database, driver: createSqliteDriver(database), exportSqliteState };
}

/** Key-sorted encoding: array order is data, plain-object member order is not. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((member) => `${JSON.stringify(member)}:${canonical(value[member])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeLegacyState(state) {
  return canonical({ ...state, routes: state.routes ?? [] });
}

function runNode(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...testEnv(options.env), NODE_NO_WARNINGS: '1' },
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin?.end();
  });
}

/** A large but ordinary v1 activity list: volume, not surprises. */
function bigLegacyState(count) {
  const state = legacyFixtureState();
  state.preamble = ['Large legacy fixture'];
  state.warmup = [];
  state.routes = [];
  state.runtime = { nextActIndex: count, observations: {}, leases: {} };
  state.acts = [];
  for (let index = 0; index < count; index += 1) {
    const actor = index % 3 === 0 ? 'Alice' : index % 3 === 1 ? 'Bob' : 'Zoë/legacy-key';
    if (index < 3) {
      state.acts.push({ kind: 'join', actor, at: 1000 + index, index });
      continue;
    }
    const say = { kind: 'say', actor, at: 1000 + index / 8, index, body: `body ${index}` };
    if (index % 7 === 0) say.reach = 'bell';
    else if (index % 2 === 0) say.mentions = ['Alice'];
    state.acts.push(say);
  }
  const observations = {};
  for (let index = 0; index < count; index += 4) observations[`act/${index}`] = { state: 'seen', at: 2000 + index };
  state.runtime.observations.Alice = observations;
  return state;
}

/** The v1 attention relations with the index that established each one. */
function attentionTimeline(acts, roster) {
  const spellings = new Map(roster.map((participant) => [participant.name.toLocaleLowerCase(), participant.name]));
  const relations = new Map();
  for (const act of acts) {
    if (act.kind !== 'listen' && act.kind !== 'ignore') continue;
    const listener = spellings.get(act.actor.toLocaleLowerCase());
    const entries = relations.get(listener) ?? [];
    const existing = entries.find((entry) => entry.target.toLocaleLowerCase() === act.target.toLocaleLowerCase());
    if (existing === undefined || existing.kind !== act.kind) {
      relations.set(listener, entries.filter((entry) => entry !== existing).concat([{ kind: act.kind, target: act.target, sinceIndex: act.index, listener }]));
    }
  }
  return roster.flatMap((participant) => relations.get(participant.name) ?? []);
}

// ─── Frozen v1 fixture toolkit ────────────────────────────────────────────────

test('the frozen v1 writer produces the exact shipped v1 framing', (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);

  const framing = v1Framing(squarePath);
  assert.equal(framing.applicationId, V1_APPLICATION_ID);
  assert.equal(framing.userVersion, 1);
  assert.equal(framing.journalMode, 'delete');
  assert.equal(framing.objects.length, 1);
  assert.equal(framing.objects[0].type, 'table');
  assert.equal(framing.objects[0].name, 'square_snapshot');
  assert.equal(normalizeSql(framing.objects[0].sql), normalizeSql(V1_SNAPSHOT_DDL));

  assert.equal(readV1SnapshotRow(squarePath).revision, 7);
  assert.deepEqual(readV1State(squarePath), legacyFixtureState());
});

test('the representative fixture is readable by the pinned shipped v1 runtime', { skip: gate(hasPinnedV1, PINNED_GATE) }, (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);

  const result = spawnSync(process.execPath, [PINNED_V1_CLI, '--location', squarePath, 'participants'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: testEnv({ NODE_NO_WARNINGS: '1' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Alice/);
  assert.match(result.stdout, /Zoë\/legacy-key/);
});

test('the frozen v1 writer agrees with the pinned shipped v1 writer', { skip: gate(hasPinnedV1, PINNED_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const frozenPath = path.join(dir, 'frozen.square');
  const pinnedPath = path.join(dir, 'pinned.square');
  const state = legacyFixtureState();
  writeV1Artifact(frozenPath, state, 0);

  const { writeSquareFile } = await import(pathToFileURL(path.join(PINNED_V1_ROOT, 'dist', 'artifact.js')).href);
  await writeSquareFile(pinnedPath, state);

  const frozen = v1Framing(frozenPath);
  const pinned = v1Framing(pinnedPath);
  assert.equal(frozen.applicationId, pinned.applicationId);
  assert.equal(frozen.userVersion, pinned.userVersion);
  assert.equal(frozen.journalMode, pinned.journalMode);
  assert.equal(frozen.objects.length, pinned.objects.length);
  assert.equal(normalizeSql(frozen.objects[0].sql), normalizeSql(pinned.objects[0].sql));
  assert.equal(readV1SnapshotRow(frozenPath).state, readV1SnapshotRow(pinnedPath).state);
});

test('v1 validation refuses a non-finite route number wherever it sits', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'dist', 'square-migration.js')).href);
  const { validateSquareState } = module;

  assert.doesNotThrow(() => validateSquareState(legacyFixtureState()));

  for (const [kind, expected] of [['updatedAt', 'routes[0].updatedAt'], ['epoch', 'routes[0].epoch'], ['extra', 'routes[0].nested.deep[0]']]) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'square-v1-nonfinite-'));
    try {
      const squarePath = path.join(dir, 'nonfinite.square');
      writeV1ArtifactText(squarePath, nonFiniteRouteText(kind), 3);
      const parsed = readV1State(squarePath);
      assert.throws(() => validateSquareState(parsed), (error) => {
        assert.equal(error.code, 'invalid_args');
        assert.equal(error.message, `Invalid square artifact: ${expected} is not a finite number.`);
        return true;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ─── Migration ────────────────────────────────────────────────────────────────

test('migration preserves the whole v1 authority losslessly', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  const state = legacyFixtureState();
  writeV1Artifact(squarePath, state, 7);

  const result = run(['--location', squarePath, 'migrate']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /legacy\.square/);

  const framing = v1Framing(squarePath);
  assert.equal(framing.applicationId, V1_APPLICATION_ID);
  assert.equal(framing.userVersion, 2);
  assert.equal(framing.journalMode, 'delete');
  assert.equal(framing.objects.some((object) => object.name === 'square_snapshot'), false);

  const { database, driver, exportSqliteState } = await openV2(squarePath);
  try {
    const header = driver.header();
    assert.equal(header.revision, 7);
    assert.equal(header.nextActIndex, 20);
    assert.equal(header.hardCap, null);
    assert.equal(header.throttlePerMinute, 5);
    assert.deepEqual(header.preamble, state.preamble);
    assert.deepEqual(header.warmup, state.warmup);
    assert.equal(normalizeLegacyState(exportSqliteState(database)), normalizeLegacyState(state));
  } finally {
    database.close();
  }
});

test('migration preserves permissive legacy values and optional-field presence', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'optional.square');
  const state = legacyFixtureState();
  delete state.throttlePerMinute;
  state.acts.find((act) => act.index === 2).mentions = [''];
  state.acts.find((act) => act.index === 11).mentions = [];
  // v1 allowed a read fence beyond assigned history; it is not a receipt.
  state.acts.find((act) => act.kind === 'read').through = 100;
  state.runtime.leases.Bob.filter = {};
  state.runtime.leases['dormant-key'].filter = { participants: [], mention: '' };
  Object.defineProperty(state.runtime.leases, '__proto__', {
    value: { leaseId: 'lone \uD800 NUL \u0000', heartbeatAt: 1.25, expiresAt: 2 }, enumerable: true,
  });

  writeV1Artifact(squarePath, state, 9);
  const { migrateSquareFile } = await import('../dist/square-migration.js');
  assert.equal((await migrateSquareFile(squarePath)).status, 'migrated');
  const { database, driver, exportSqliteState } = await openV2(squarePath);
  try {
    assert.equal(driver.header().revision, 9);
    // Full equality includes absent vs empty mentions/filter, owner spellings,
    // ordered duplicate routes with extras, and Unicode/NUL strings.
    assert.deepEqual(exportSqliteState(database), state);
  } finally {
    database.close();
  }
});

test('legacy validation retains envelope, ordering and assigned-reference errors', async () => {
  const { validateSquareState } = await import('../dist/square-migration.js');
  const malformed = 'Invalid square artifact: snapshot schema is malformed.';
  const cases = [
    [(state) => { state.unowned = true; }, malformed],
    [(state) => { state.acts[1].index = state.acts[0].index; }, malformed],
    [(state) => { state.acts.find((act) => act.reply !== undefined).reply = 11; }, malformed],
    [(state) => { state.runtime.nextActIndex = 14; }, 'Invalid square artifact: nextActIndex is behind the activity history.'],
    [(state) => { state.runtime.observations.Alice['act/20'] = { state: 'seen', at: 2 }; }, 'Invalid square artifact: runtime references an unassigned activity index.'],
  ];
  for (const [mutate, message] of cases) {
    const state = legacyFixtureState();
    mutate(state);
    assert.throws(() => validateSquareState(state), { code: 'invalid_args', message });
  }
});

test('migration rebuilds derived facts equal to the frozen v1 replay', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  if (!fs.existsSync(ORACLE)) return t.skip('awaits the runtime delivery\'s frozen v1 oracle, test/fixtures/legacy-square-core.js');
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  const state = legacyFixtureState();
  writeV1Artifact(squarePath, state, 7);
  assert.equal(run(['--location', squarePath, 'migrate']).status, 0);

  const oracle = await import('./fixtures/legacy-square-core.js');
  const folded = oracle.fold(state.acts);
  const replay = oracle.replayLandedAudiences(state.acts);
  const expectedRoster = folded.participants.map((participant) => ({
    name: participant.name,
    joined: participant.joined,
    done: participant.done,
    sayCount: participant.activityCount,
    lastActiveAt: participant.lastActiveAt,
    lastJoinIndex: replay.lastJoinIndex(participant.name),
  }));

  const { database, driver } = await openV2(squarePath);
  try {
    assert.deepEqual(
      driver.roster().map(({ name, joined, done, sayCount, lastActiveAt, lastJoinIndex }) =>
        ({ name, joined, done, sayCount, lastActiveAt, lastJoinIndex })),
      expectedRoster,
    );

    const expectedAttention = attentionTimeline(state.acts, expectedRoster);
    const attention = expectedRoster.flatMap(({ name }) =>
      driver.attention(name).map(({ kind, target, sinceIndex, listener }) => ({ kind, target, sinceIndex, listener })));
    assert.deepEqual(attention, expectedAttention);
    assert.deepEqual(driver.attention('Unknown/Peer'), []);
    assert.deepEqual(driver.incomingAttention('never-landed'), []);

    for (const act of state.acts) {
      if (act.kind !== 'say') continue;
      assert.deepEqual(
        driver.audience(act.index).map(({ recipient, route }) => ({ recipient, route })),
        replay.groups(act.index),
        `audience of act/${act.index}`,
      );
    }

    assert.deepEqual(driver.hold(), folded.hold.active
      ? { active: true, at: folded.hold.at, reason: folded.hold.reason, actor: folded.hold.actor }
      : { active: false });
  } finally {
    database.close();
  }
});

test('a second migration is a no-op that leaves the artifact byte-identical', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);
  assert.equal(run(['--location', squarePath, 'migrate']).status, 0);

  const before = digest(squarePath);
  const second = run(['--location', squarePath, 'migrate']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /format 2/i);
  assert.equal(digest(squarePath), before);

  const { database, driver } = await openV2(squarePath);
  try {
    assert.equal(driver.header().revision, 7);
  } finally {
    database.close();
  }
});

test('invalid or unsupported artifacts refuse without writing', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const cases = [];

  const add = (name, build, pattern, { hash = true } = {}) => {
    const squarePath = path.join(dir, name);
    build(squarePath);
    cases.push({ name, squarePath, pattern, hash, before: digest(squarePath) });
  };

  add('nonfinite.square', (file) => writeV1ArtifactText(file, nonFiniteRouteText('updatedAt'), 3), /not a finite number/);
  add('nonfinite-extra.square', (file) => writeV1ArtifactText(file, nonFiniteRouteText('extra'), 3), /not a finite number/);
  add('corrupt.square', (file) => writeV1ArtifactText(file, '{"hardCap":', 1), /Invalid square artifact/);
  add('unrelated.square', (file) => writeRawSqlite(file, 'PRAGMA application_id = 7; CREATE TABLE note (x INTEGER)'), /unrelated SQLite database/);
  add('unsupported.square', (file) => {
    writeV1Artifact(file, legacyFixtureState(), 1);
    const database = openRaw(file);
    try { database.exec('PRAGMA user_version = 3'); } finally { database.close(); }
  }, /unsupported SQLite format version/);
  add('extra-table.square', (file) => {
    writeV1Artifact(file, legacyFixtureState(), 1);
    const database = openRaw(file);
    try { database.exec('CREATE TABLE leftovers (x INTEGER)'); } finally { database.close(); }
  }, /unsupported snapshot schema/);
  add('wal.square', (file) => {
    writeV1Artifact(file, legacyFixtureState(), 1);
    const database = openRaw(file);
    try { database.exec('PRAGMA journal_mode = WAL'); } finally { database.close(); }
  }, /unsupported journal mode/, { hash: false });

  for (const entry of cases) {
    const result = run(['--location', entry.squarePath, 'migrate']);
    assert.notEqual(result.status, 0, `${entry.name} should refuse`);
    assert.match(result.stderr, entry.pattern, entry.name);
    if (entry.hash) assert.equal(digest(entry.squarePath), entry.before, `${entry.name} must be untouched`);
  }
  // A refused WAL artifact keeps the journal mode it had: never rewritten.
  assert.equal(v1Framing(path.join(dir, 'wal.square')).journalMode, 'wal');
  // An owned v1 artifact with a bad snapshot still reports its version unchanged.
  assert.equal(v1Framing(path.join(dir, 'corrupt.square')).userVersion, 1);

  const absent = path.join(dir, 'absent.square');
  const missing = run(['--location', absent, 'migrate']);
  assert.notEqual(missing.status, 0);
  assert.equal(fs.existsSync(absent), false);
});

test('a kill with the conversion uncommitted rolls back to the complete v1 authority', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const big = bigLegacyState(500);
  const squarePath = path.join(dir, 'precommit.square');
  writeV1Artifact(squarePath, big, 3);

  // The fixture announces the live transaction that already carries the format
  // flip, then waits: the kill lands before COMMIT by rendezvous, not by guessing
  // a fraction of a previous run's duration.
  const ready = path.join(dir, 'precommit.ready');
  const child = spawn(process.execPath, [path.join(FIXTURES, 'v1-precommit-migrator.js'), CLI, squarePath, ready], {
    cwd: ROOT,
    env: testEnv({ NODE_NO_WARNINGS: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The listener is installed at spawn, so a fast failure cannot close first and
  // leave the test waiting on an event that already happened.
  const closed = new Promise((resolve) => child.once('close', (status, signal) => resolve({ status, signal })));
  let exited = false;
  child.once('exit', () => { exited = true; });
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(ready) && Date.now() < deadline && !exited) await sleep(20);
  assert.equal(fs.existsSync(ready), true, 'the conversion never reached COMMIT');
  const journal = `${squarePath}-journal`;
  const hot = fs.existsSync(journal);

  child.kill('SIGKILL');
  const outcome = await closed;
  assert.equal(outcome.signal, 'SIGKILL', `the migrator must be killed, not finished: ${JSON.stringify(outcome)}`);
  assert.equal(hot, true, 'the killed transaction had written pages and left a hot journal');

  // Uncommitted writes are rolled back: the whole v1 authority is still there.
  const framing = v1Framing(squarePath);
  assert.equal(framing.userVersion, 1);
  assert.deepEqual(framing.objects.map((object) => object.name), ['square_snapshot']);
  assert.deepEqual(readV1State(squarePath), big);

  // And the retry converts exactly once, preserving everything the killed run had.
  const retried = run(['--location', squarePath, 'migrate']);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(fs.existsSync(journal), false, 'the retry cleared the hot journal it recovered from');
  const { database, driver, exportSqliteState } = await openV2(squarePath);
  try {
    assert.equal(driver.header().nextActIndex, big.runtime.nextActIndex);
    assert.equal(normalizeLegacyState(exportSqliteState(database)), normalizeLegacyState(big));
  } finally {
    database.close();
  }
});

test('a busy COMMIT retries the same transaction and converts exactly once', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  const state = legacyFixtureState();
  writeV1Artifact(squarePath, state, 7);

  // Hold a SHARED read lock from this process so the migration's COMMIT meets
  // SQLITE_BUSY and has to retry the same transaction.
  const holder = openRaw(squarePath);
  holder.exec('BEGIN');
  holder.prepare('SELECT state FROM square_snapshot WHERE id = 1').get();
  t.after(() => {
    try { holder.exec('ROLLBACK'); } catch { /* released already */ }
    try { holder.close(); } catch { /* released already */ }
  });

  const started = Date.now();
  const migrating = runAsync(['--location', squarePath, 'migrate']);
  await sleep(400);
  holder.exec('COMMIT');
  holder.close();
  const result = await migrating;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started >= 380, 'migration should have waited for the read lock');

  const { database, driver, exportSqliteState } = await openV2(squarePath);
  try {
    assert.equal(driver.header().revision, 7);
    assert.equal(driver.header().nextActIndex, 20);
    assert.equal(normalizeLegacyState(exportSqliteState(database)), normalizeLegacyState(state));
  } finally {
    database.close();
  }
});

test('a migrator cannot fold a second conversion into the framing reads', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  const state = legacyFixtureState();
  writeV1Artifact(squarePath, state, 7);

  // The window this closes: identity, journal mode, schema and columns are four
  // statements. Injecting a foreign writer between the first two — exactly where a
  // finishing migrator used to commit — must not move the artifact mid-preflight.
  // A blocking second migration is impossible to inject here without deadlocking
  // on our own snapshot, so the probe is the smallest real writer: flip the format
  // from another connection and commit. It is refused, and the migration still
  // converts once with every fact intact.
  const uri = pathToFileURL(path.resolve(squarePath));
  uri.searchParams.set('mode', 'rw');
  const probe = `const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.argv[1]);
database.exec('PRAGMA busy_timeout = 0');
try {
  database.exec('BEGIN IMMEDIATE');
  database.exec('PRAGMA user_version = 2');
  database.exec('COMMIT');
  process.stdout.write('committed');
} catch (error) {
  process.stdout.write(\`refused: \${error.message}\`);
  process.exit(3);
}`;

  const attempts = [];
  const prepare = DatabaseSync.prototype.prepare;
  let armed = true;
  DatabaseSync.prototype.prepare = function intercepted(sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest);
    if (!armed) return statement;
    armed = false;
    const get = statement.get.bind(statement);
    statement.get = (...args) => {
      const row = get(...args);
      attempts.push(spawnSync(process.execPath, ['-e', probe, uri.href], { cwd: ROOT, encoding: 'utf8', env: testEnv() }));
      return row;
    };
    return statement;
  };
  t.after(() => { DatabaseSync.prototype.prepare = prepare; });

  const { migrateSquareFile } = await import(pathToFileURL(path.join(ROOT, 'dist', 'square-migration.js')).href);
  const outcome = await migrateSquareFile(squarePath);
  assert.equal(attempts.length, 1, 'the probe must run inside the framing read');
  assert.notEqual(attempts[0].status, 0, `a foreign writer must not commit inside preflight: ${attempts[0].stdout}`);
  assert.match(attempts[0].stdout, /refused: database is locked|refused: database is busy/);
  assert.equal(outcome.status, 'migrated');

  const { database, driver, exportSqliteState } = await openV2(squarePath);
  try {
    assert.equal(driver.header().revision, 7);
    assert.equal(driver.header().nextActIndex, 20);
    assert.equal(normalizeLegacyState(exportSqliteState(database)), normalizeLegacyState(state));
  } finally {
    database.close();
  }
});

test('a transient exclusive writer delays the preflight instead of refusing it', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  const state = legacyFixtureState();
  writeV1Artifact(squarePath, state, 7);

  // Imported before the writer takes the lock, so no module load can slip between
  // the lock and the read that must meet it.
  const { migrateSquareFile } = await import(pathToFileURL(path.join(ROOT, 'dist', 'square-migration.js')).href);

  // An exclusive writer holds the artifact while the migration starts, so the very
  // first framing read meets SQLITE_BUSY. It has to be waited out, not surfaced.
  const holder = openRaw(squarePath);
  holder.exec('BEGIN EXCLUSIVE');
  holder.exec('SELECT count(*) FROM square_snapshot');
  t.after(() => {
    try { holder.exec('ROLLBACK'); } catch { /* released already */ }
    try { holder.close(); } catch { /* released already */ }
  });

  const started = Date.now();
  let settled = 'pending';
  const pending = migrateSquareFile(squarePath).then(
    (value) => { settled = 'converted'; return value; },
    (error) => { settled = 'refused'; throw error; },
  );
  await sleep(150);
  assert.equal(settled, 'pending', 'the preflight waits for the writer instead of failing at once');

  holder.exec('ROLLBACK');
  holder.close();
  const outcome = await pending;
  assert.equal(outcome.status, 'migrated');
  assert.ok(Date.now() - started >= 150, 'the read waited for the writer');

  const { database, driver, exportSqliteState } = await openV2(squarePath);
  try {
    assert.equal(driver.header().revision, 7);
    assert.equal(normalizeLegacyState(exportSqliteState(database)), normalizeLegacyState(state));
  } finally {
    database.close();
  }
});

test('cancelling a preflight that waits for the writer leaves the artifact alone', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);
  const before = digest(squarePath);

  const { migrateSquareFile } = await import(pathToFileURL(path.join(ROOT, 'dist', 'square-migration.js')).href);

  const holder = openRaw(squarePath);
  holder.exec('BEGIN EXCLUSIVE');
  holder.exec('SELECT count(*) FROM square_snapshot');
  t.after(() => {
    try { holder.exec('ROLLBACK'); } catch { /* released already */ }
    try { holder.close(); } catch { /* released already */ }
  });

  const cancelled = new AbortController();
  const reason = new Error('cancelled by the test');
  let settled = 'pending';
  const pending = migrateSquareFile(squarePath, cancelled.signal).then(
    (value) => { settled = 'converted'; return value; },
    (error) => { settled = 'refused'; throw error; },
  );
  await sleep(150);
  assert.equal(settled, 'pending', 'the cancelled read was waiting, not refusing');
  cancelled.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(digest(squarePath), before, 'a cancelled preflight writes nothing');

  holder.exec('ROLLBACK');
  holder.close();
  assert.equal(v1Framing(squarePath).userVersion, 1);
  assert.equal(run(['--location', squarePath, 'migrate']).status, 0, 'the artifact is still migratable');
});

test('a second migrator follows the same in-lock check', { skip: gate(MIGRATION, MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  const state = legacyFixtureState();
  writeV1Artifact(squarePath, state, 7);

  const [first, second] = await Promise.all([
    runAsync(['--location', squarePath, 'migrate']),
    runAsync(['--location', squarePath, 'migrate']),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  for (const result of [first, second]) {
    assert.match(result.stdout, /migrated to row storage|already format 2/);
  }
  assert.equal([first, second].filter((result) => /migrated to row storage/.test(result.stdout)).length === 1, true,
    `exactly one migrator converts: ${first.stdout}${second.stdout}`);

  const { database, driver, exportSqliteState } = await openV2(squarePath);
  try {
    assert.equal(driver.header().revision, 7);
    assert.equal(driver.header().nextActIndex, 20);
    assert.equal(normalizeLegacyState(exportSqliteState(database)), normalizeLegacyState(state));
  } finally {
    database.close();
  }
});

test('an old v1 writer lands before the conversion and meets the version gate after it', { skip: gate(MIGRATION && hasPinnedV1, MIGRATION ? PINNED_GATE : MIGRATION_GATE) }, async (t) => {
  const dir = fixtureDirectory(t);
  const state = legacyFixtureState();
  // A bare reach: without --no-mention the shipped CLI refuses the command itself
  // and never touches storage, which is the evidence this test exists to provide.
  const express = (squarePath) => ['--location', squarePath, '--as', 'Alice', 'express', '-f', '--no-mention', 'old writer speak'];

  const landed = path.join(dir, 'landed.square');
  writeV1Artifact(landed, state, 7);
  const writer = await runNode(PINNED_V1_CLI, express(landed));
  assert.equal(writer.status, 0, writer.stderr);
  // The shipped writer leaves revision 9 for one landing: the act itself and the
  // actor's own receipt both bump the counter. Whatever it writes is authority.
  const written = readV1SnapshotRow(landed).revision;
  assert.equal(written, 9, `the shipped writer's revision: ${writer.stdout}`);

  const migrator = await runNode(CLI, ['--location', landed, 'migrate']);
  assert.equal(migrator.status, 0, migrator.stderr);
  const migrated = await openV2(landed);
  try {
    assert.equal(migrated.driver.header().revision, written);
    assert.equal(migrated.driver.header().lastActIndex, 20);
    assert.equal(migrated.driver.header().nextActIndex, 21);
    assert.equal(migrated.exportSqliteState(migrated.database).acts.some((act) => act.body === 'old writer speak'), true);
  } finally {
    migrated.database.close();
  }

  const converted = path.join(dir, 'converted.square');
  writeV1Artifact(converted, state, 7);
  assert.equal(run(['--location', converted, 'migrate']).status, 0);

  const refused = await runNode(PINNED_V1_CLI, express(converted));
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stderr, /unsupported SQLite format version/);
  assert.doesNotMatch(refused.stderr, /express needs|invalid arguments|--mention/);

  const untouched = await openV2(converted);
  try {
    assert.equal(untouched.driver.header().revision, 7);
    assert.equal(untouched.driver.header().nextActIndex, 20);
    assert.equal(untouched.exportSqliteState(untouched.database).acts.some((act) => act.body === 'old writer speak'), false);
  } finally {
    untouched.database.close();
  }
});

test('the v2 runtime refuses a v1 artifact with the exact migration recovery command', { skip: gate(V2, GATE) }, (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);
  const before = digest(squarePath);

  const result = run(['--location', squarePath, 'status']);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /migration/);
  assert.ok(result.stderr.includes(`square --location '${squarePath}' migrate`), result.stderr);
  assert.equal(digest(squarePath), before);
});

test('doctor names legacy v1 and its recovery command', { skip: gate(V2, GATE) }, (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);
  const before = digest(squarePath);

  const result = run(['--location', squarePath, 'doctor']);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.ok(output.includes(`square --location '${squarePath}' migrate`), output);
  assert.doesNotMatch(output, /damaged|corrupt/i);
  assert.equal(digest(squarePath), before);
});

test('a migrated artifact serves the row runtime as an ordinary square', { skip: gate(MIGRATION, MIGRATION_GATE) }, (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  const state = legacyFixtureState();
  writeV1Artifact(squarePath, state, 7);
  assert.equal(run(['--location', squarePath, 'migrate']).status, 0);

  const participants = run(['--location', squarePath, 'participants']);
  assert.equal(participants.status, 0, participants.stderr);
  for (const name of ['Alice', 'Bob', 'Zoë/legacy-key']) assert.ok(participants.stdout.includes(name), participants.stdout);

  const history = run(['--location', squarePath, 'history', '--limit', '100']);
  assert.equal(history.status, 0, history.stderr);
  for (const body of ['hello @Bob', 'bell to everyone', 'a reply']) assert.ok(history.stdout.includes(body), history.stdout);
});

test('build --force does not bypass the v1 refusal', { skip: gate(V2, GATE) }, (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);
  const before = digest(squarePath);

  const result = run(['--location', squarePath, 'build', '-f'], { input: 'replacement' });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Square artifact needs migration/);
  assert.equal(v1Framing(squarePath).userVersion, 1);
  assert.equal(digest(squarePath), before);
});

test('the migrate command takes no options and is documented', { skip: gate(MIGRATION, MIGRATION_GATE) }, (t) => {
  const dir = fixtureDirectory(t);
  const squarePath = path.join(dir, 'legacy.square');
  writeV1Artifact(squarePath, legacyFixtureState(), 7);
  const before = digest(squarePath);

  for (const flag of ['--check', '--backup', '--force', '--dry-run']) {
    const result = run(['--location', squarePath, 'migrate', flag]);
    assert.equal(result.status, 2, `${flag} must be refused: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /invalid arguments/);
    assert.equal(digest(squarePath), before);
  }

  const help = run(['help', 'migrate']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /square \[--location <square>\] migrate/);
  assert.match(run(['help']).stdout, /migrate/);
});
