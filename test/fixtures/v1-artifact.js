// Frozen copy of the shipped v1 artifact storage (square 0.3.70, commit 99679eb).
//
// Test-only. It builds AUTHENTIC pre-migration artifacts: the framing, DDL and
// insertion order below are transcribed from `artifact.ts` at that commit, so a
// fixture produced here is a real v1 database rather than v2 code pretending to
// be old. Production code must never import this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const V1_APPLICATION_ID = 0x53515245;
export const V1_USER_VERSION = 1;
export const V1_SNAPSHOT_TABLE = 'square_snapshot';
export const V1_SNAPSHOT_DDL = `CREATE TABLE ${V1_SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL)`;

function openWritable(squarePath) {
  const uri = new URL(`file://${path.resolve(squarePath)}`);
  uri.searchParams.set('mode', 'rw');
  return new DatabaseSync(uri.href);
}

/** Writes one v1 artifact exactly as the shipped v1 creator did. */
export function writeV1Artifact(squarePath, state, revision = 0) {
  writeV1ArtifactText(squarePath, JSON.stringify(state), revision);
}

/**
 * Writes one v1 artifact whose snapshot text is supplied verbatim. Used for
 * hand-authored JSON the shipped writer would never produce (for example
 * `1e999`, which JSON.parse turns into Infinity).
 */
export function writeV1ArtifactText(squarePath, stateText, revision = 0) {
  // The shipped creator published an already-created empty file, then opened it
  // create-disabled. Mirror that so the framing is byte-for-byte the real thing.
  if (!fs.existsSync(squarePath)) fs.writeFileSync(squarePath, '');
  const database = openWritable(squarePath);
  try {
    database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
    database.exec(`PRAGMA application_id = ${V1_APPLICATION_ID}; PRAGMA user_version = ${V1_USER_VERSION}; ${V1_SNAPSHOT_DDL};`);
    database.prepare(`INSERT INTO ${V1_SNAPSHOT_TABLE} (id, revision, state) VALUES (1, 0, ?)`).run(stateText);
    database.prepare(`UPDATE ${V1_SNAPSHOT_TABLE} SET revision = ? WHERE id = 1`).run(revision);
    database.exec('COMMIT;');
  } finally {
    database.close();
  }
}

/** A create-enabled raw SQLite file: for unrelated or deliberately odd fixtures. */
export function writeRawSqlite(squarePath, sql) {
  const database = new DatabaseSync(path.resolve(squarePath));
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

/** Framing facts an operator or a test can assert without decoding the snapshot. */
export function v1Framing(squarePath) {
  const database = openWritable(squarePath);
  try {
    const identity = database.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get();
    const journalMode = database.prepare('PRAGMA journal_mode').get();
    const objects = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all();
    return { applicationId: identity.application_id, userVersion: identity.user_version, journalMode: journalMode.journal_mode, objects };
  } finally {
    database.close();
  }
}

/** The raw snapshot row, exactly as stored. */
export function readV1SnapshotRow(squarePath) {
  const database = openWritable(squarePath);
  try {
    const row = database.prepare(`SELECT id, revision, state FROM ${V1_SNAPSHOT_TABLE}`).get();
    return { id: row.id, revision: row.revision, state: row.state };
  } finally {
    database.close();
  }
}

export function readV1State(squarePath) {
  return JSON.parse(readV1SnapshotRow(squarePath).state);
}

/**
 * The representative lossless v1 snapshot: assigned-coordinate gaps, orphan and
 * pre-join receipts, receipts whose owner spelling only differs by case, a
 * dormant lease owner, absent say.mentions, a bell, a reply, listen/ignore with
 * differing target spelling, actor-less hold/resume, a read fence, duplicate and
 * extra-bearing routes, fractional timestamps, a lone surrogate and a NUL.
 *
 * Every string here survives JSON round-trips; nothing in it is normalized by
 * the shipped v1 writer.
 */
export function legacyFixtureState() {
  return {
    hardCap: null,
    throttlePerMinute: 5,
    preamble: ['Legacy fixture', '', 'second line'],
    warmup: ['warmup alpha', 'warmup beta'],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1000.5, index: 0 },
      { kind: 'join', actor: 'Bob', at: 1001, index: 1 },
      { kind: 'say', actor: 'Alice', at: 1002.25, index: 2, body: 'hello @Bob', mentions: ['Bob'] },
      { kind: 'listen', actor: 'Bob', at: 1003, index: 3, target: 'Alice' },
      // index 4 is an assigned coordinate with no activity.
      { kind: 'say', actor: 'Bob', at: 1005, index: 5, body: 'bell to everyone', reach: 'bell' },
      // index 6 is an assigned coordinate with no activity.
      { kind: 'ignore', actor: 'Bob', at: 1006, index: 7, target: 'alice' },
      { kind: 'hold', actor: 'Alice', at: 1007.5, index: 8, body: 'stepping away' },
      { kind: 'hold', at: 1008, index: 9 },
      { kind: 'resume', at: 1009.25, index: 10 },
      { kind: 'say', actor: 'Alice', at: 1011, index: 11, body: 'a reply', reply: 2 },
      { kind: 'read', actor: 'Alice', at: 1011.5, index: 12, through: 11 },
      { kind: 'done', actor: 'Bob', at: 1012, index: 13, body: 'bye' },
      { kind: 'say', actor: 'Zoë/legacy-key', at: 1013.75, index: 14, body: 'lone \uD800 surrogate and NUL \u0000 byte' },
      // index 15..19 are assigned coordinates with no activity.
    ],
    routes: [
      { kind: 'paseo', location: '/tmp/legacy-a', participant: 'Alice', sessionId: 'session-1', channel: 'channel-1', address: { host: 'a', port: '1' }, updatedAt: 1000.5, epoch: 3, label: 'kept extra' },
      { kind: 'codex-queue', location: '/tmp/legacy-a', participant: 'Alice', sessionId: 'session-1', channel: 'channel-1', address: { host: 'a', port: '1' }, updatedAt: 1001.25 },
      { kind: 'claude-native', location: '/tmp/legacy-b', participant: 'Zoë/legacy-key', sessionId: 'session-3', channel: '', address: {}, updatedAt: 1002, epoch: 'legacy-string-epoch' },
    ],
    runtime: {
      nextActIndex: 20,
      observations: {
        Alice: { 'act/2': { state: 'seen', at: 1002.5 }, 'act/12': { state: 'seen', at: 1012.5 } },
        alice: { 'act/3': { state: 'seen', at: 1003.5 } },
        'Ghost/Orphan': { 'act/17': { state: 'seen', at: 1017.25 } },
        Zoë: { 'act/14': { state: 'seen', at: 1014 } },
      },
      leases: {
        Bob: { leaseId: 'lease-1', heartbeatAt: 1030.5, expiresAt: 1090.25, filter: { participants: ['Alice'], mention: 'Alice' } },
        'dormant-key': { leaseId: 'lease-2', heartbeatAt: 1040, expiresAt: 1100 },
      },
    },
  };
}

/**
 * A v1 snapshot whose route carries an exponent-overflow number. `1e999` is
 * valid JSON that the shipped permissive validator accepts, and JSON.parse turns
 * it into Infinity. Migration must refuse these before any write.
 */
export function nonFiniteRouteText(kind = 'updatedAt') {
  const state = legacyFixtureState();
  const route = {
    kind: 'paseo', location: '/tmp/legacy-a', participant: 'Alice', sessionId: 'session-1',
    channel: 'channel-1', address: {}, updatedAt: 1000,
  };
  if (kind === 'epoch') route.epoch = 'OVERFLOW';
  if (kind === 'extra') route.nested = { deep: ['OVERFLOW'] };
  state.routes = [route];
  const text = JSON.stringify(state);
  return kind === 'updatedAt'
    ? text.replace('"updatedAt":1000', '"updatedAt":1e999')
    : text.replace(/"OVERFLOW"/g, '1e999');
}

export function fixtureDirectory(t) {
  // realpath first: the recovery command text contains whatever path the caller
  // passed, and /var/... resolves to /private/var/... on macOS.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'square-v1-fixture-'));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
