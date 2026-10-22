import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Square } from '../dist/square-api.js';
import { diagnoseSquareFile } from '../dist/artifact.js';
import { migrateSquareFile } from '../dist/square-migration.js';
import { legacyFixtureState, writeV1Artifact } from './fixtures/v1-artifact.js';

const v2Sql = fs.readFileSync(new URL('./fixtures/v2-artifact.sql', import.meta.url), 'utf8');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v2-unlisten-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, 'PUBLIC.square');
  const database = new DatabaseSync(location);
  try { database.exec(v2Sql); } finally { database.close(); }
  return location;
}
const digest = location => crypto.createHash('sha256').update(fs.readFileSync(location)).digest('hex');
function rows(location) {
  const database = new DatabaseSync(location, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM ${name}`).all()]));
  } finally { database.close(); }
}

test('v2 migration changes only the activity schema/version and preserves every stored row', async (t) => {
  const location = fixture(t), before = rows(location), bytes = digest(location);
  await assert.rejects(Square.at({ path: location }), error => error.facts?.reason === 'migration_required');
  assert.equal(digest(location), bytes, 'ordinary opens do not migrate');
  assert.match((await diagnoseSquareFile(location)).migrationRequired, /migrate/);
  const migrated = await migrateSquareFile(location);
  assert.equal(migrated.status, 'migrated');
  assert.deepEqual(rows(location), before, 'revision, indices, payloads, receipts, leases, attention and landed audience are unchanged');
  const database = new DatabaseSync(location, { readOnly: true });
  try { assert.equal(database.prepare('PRAGMA user_version').get().user_version, 3); }
  finally { database.close(); }
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
  const currentBytes = digest(location);
  assert.equal((await migrateSquareFile(location)).status, 'already-current');
  assert.equal(digest(location), currentBytes);
  const square = await Square.at({ path: location });
  try {
    const bob = await square.participant('Bob');
    assert.equal((await bob.unlisten('Alice')).activity.kind, 'unlisten');
    // The unconsumed v2 bare message remains addressed to Bob after unlisten.
    assert.deepEqual((await bob.catch()).activities.map(activity => activity.body), ['v2 pending bare']);
  } finally { await square.close(); }
});

test('a failed v2 activity-table copy rolls back both schema and rows', async (t) => {
  const location = fixture(t), before = digest(location);
  const exec = DatabaseSync.prototype.exec;
  const failure = new Error('injected after the activity rows were copied');
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    const drop = sql.indexOf('DROP TABLE activities_v2;');
    if (sql.includes('ALTER TABLE activities RENAME TO activities_v2;') && drop !== -1) {
      exec.call(this, sql.slice(0, drop));
      throw failure;
    }
    return exec.call(this, sql);
  });
  await assert.rejects(migrateSquareFile(location), error => error === failure);
  mock.mock.restore();
  assert.equal(digest(location), before);
  assert.equal((await migrateSquareFile(location)).status, 'migrated');
});

test('migration refuses malformed v2 framing/header and v1 envelopes containing new events', async (t) => {
  for (const corruption of ['extra schema', 'missing header', 'new event in v1']) await t.test(corruption, async (t) => {
    const location = fixture(t);
    if (corruption === 'new event in v1') {
      fs.rmSync(location);
      const state = legacyFixtureState();
      state.acts.push({ kind: 'unlisten', actor: 'Bob', target: 'Alice', at: 2000, index: state.runtime.nextActIndex++ });
      writeV1Artifact(location, state, 7);
    } else {
      const database = new DatabaseSync(location);
      try { database.exec(corruption === 'extra schema' ? 'CREATE TABLE unexpected(note TEXT)' : 'DELETE FROM square_meta'); }
      finally { database.close(); }
    }
    const before = digest(location);
    await assert.rejects(migrateSquareFile(location), /Invalid square artifact/);
    assert.equal(digest(location), before);
  });
});
