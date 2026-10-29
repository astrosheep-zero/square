import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Square } from '../dist/square-api.js';
import { createArtifactPort, diagnoseSquareFile } from '../dist/artifact.js';
import { CURRENT_USER_VERSION } from '../dist/square-sqlite.js';
import { migrateSquareFile } from '../dist/square-migration.js';
import { writeLegacyLedger } from './fixtures/legacy-host-ledger.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v2-unlisten-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, 'PUBLIC.square');
  const sql = fs.readFileSync(new URL('./fixtures/v2-artifact.sql', import.meta.url), 'utf8');
  const database = new DatabaseSync(location);
  try {
    database.exec(sql);
    const insert = database.prepare('INSERT INTO routes(position,participant_key_json,session_json,kind,updated_at,payload_json) VALUES(?,?,?,?,?,?)');
    for (const [position, participant, session] of [[0, 'Alice', 'alice-session'], [1, 'Bob', 'bob-session'], [2, 'Cara', 'cara-session']]) {
      insert.run(position, JSON.stringify(participant.toLocaleLowerCase()), JSON.stringify(session), 'paseo', 1010 + position,
        JSON.stringify({ location, participant, channel: 'codex', address: { agentId: participant.toLocaleLowerCase() }, extra: {} }));
    }
  } finally { database.close(); }
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'host-ledger') };
  writeLegacyLedger(env.SQUARE_HOST_LEDGER_ROOT, [], ['Alice', 'Bob', 'Cara'].map(participant => ({
    v: 1, location, participant, session: `${participant.toLowerCase()}-session`, channel: 'codex', updatedAt: 1010,
  })));
  return { location, env };
}

function digest(location) { return crypto.createHash('sha256').update(fs.readFileSync(location)).digest('hex'); }
function read(location, sql) {
  const database = new DatabaseSync(location, { readOnly: true });
  try { return database.prepare(sql).all(); } finally { database.close(); }
}

test('explicit v2 migration establishes artifact seats and removes legacy routes', async (t) => {
  const { location, env } = fixture(t);
  const before = {
    activities: read(location, 'SELECT * FROM activities ORDER BY act_index'),
    attention: read(location, 'SELECT * FROM attention ORDER BY listener_key_json,target_key_json'),
    audience: read(location, 'SELECT * FROM landed_audience ORDER BY act_index,recipient_order'),
    receipts: read(location, 'SELECT * FROM receipts ORDER BY owner_json,act_index'),
  };
  const bytes = digest(location);
  await assert.rejects(Square.at({ path: location }), error => error.facts?.reason === 'migration_required');
  assert.equal(digest(location), bytes, 'ordinary opens do not migrate');
  assert.match((await diagnoseSquareFile(location)).migrationRequired, /migrate/);

  const migrated = await migrateSquareFile(location, undefined, env);
  assert.equal(migrated.status, 'migrated');
  assert.equal(migrated.standing, 3);
  assert.deepEqual(read(location, 'SELECT * FROM activities ORDER BY act_index'), before.activities);
  assert.deepEqual(read(location, 'SELECT * FROM attention ORDER BY listener_key_json,target_key_json'), before.attention);
  assert.deepEqual(read(location, 'SELECT * FROM landed_audience ORDER BY act_index,recipient_order'), before.audience);
  assert.deepEqual(read(location, 'SELECT * FROM receipts ORDER BY owner_json,act_index'), before.receipts);
  assert.equal(read(location, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='routes'")[0].n, 0);
  assert.equal(read(location, 'SELECT COUNT(*) AS n FROM seats')[0].n, 3);
  assert.equal(read(location, 'SELECT user_version FROM pragma_user_version')[0].user_version, CURRENT_USER_VERSION);
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });

  const currentBytes = digest(location);
  assert.equal((await migrateSquareFile(location, undefined, env)).status, 'already-current');
  assert.equal(digest(location), currentBytes, 'current migration is a byte-preserving no-op');

  const square = await Square.at({ path: location });
  try {
    const bob = await square.participant('Bob', { body: { channel: 'codex', session: 'bob-session' } });
    assert.equal((await bob.unlisten('Alice')).activity.kind, 'unlisten');
    assert.deepEqual((await bob.catch()).activities.map(activity => activity.body), ['v2 pending bare']);
  } finally { await square.close(); }
});

test('v2 migration recovers an owner-backed seat without routes or a fabricated wake address', async (t) => {
  const { location, env } = fixture(t);
  const database = new DatabaseSync(location);
  try { database.prepare('DELETE FROM routes WHERE participant_key_json=?').run(JSON.stringify('alice')); }
  finally { database.close(); }
  const result = await migrateSquareFile(location, undefined, env);
  assert.equal(result.counts.recoveredSeats, 3);
  assert.equal(result.counts.unownedStanding, 0);
  assert.equal(result.counts.sharedBodySeats, 0);
  const artifact = createArtifactPort(location);
  try {
    const { value } = await artifact.read(facts => facts.seat('Alice'));
    assert.deepEqual(value.body, { channel: 'codex', session: 'alice-session' });
    assert.equal(value.generation, 'act/0');
    assert.equal(value.wakeAddress, undefined);
  } finally { await artifact.close(); }
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
});

test('v2 migration refuses malformed framing without changing the artifact', async (t) => {
  const { location, env } = fixture(t);
  const database = new DatabaseSync(location);
  try { database.exec('CREATE TABLE unexpected(note TEXT)'); }
  finally { database.close(); }
  const before = digest(location);
  await assert.rejects(migrateSquareFile(location, undefined, env), /unsupported row schema/);
  assert.equal(digest(location), before);
});
