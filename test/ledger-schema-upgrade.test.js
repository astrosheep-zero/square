import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { migrateHostLedger, verifyHostLedger } from '../dist/host-ledger-migration.js';
import { LEDGER_FILENAME, LEDGER_VERSION, initializeLedger, insertLedgerRecord, setLedgerRevisions } from '../dist/host-ledger-sqlite.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, LEDGER_FILENAME);
  const db = new DatabaseSync(file);
  try {
    initializeLedger(db);
    const base = { v: 1, location: path.join(root, 'S.square'), participant: 'Bob', session: 'receiver' };
    insertLedgerRecord(db, 'presence', { ...base, channel: 'claude-code', updatedAt: 1, epoch: 7 });
    const native = { ...base, activity: 'act/2', kind: 'wake', outcome: 'failed', at: 1, claimToken: 'old-native-token', nativeDelivery: { harness: 'claude', endpoint: '/private/endpoint', epoch: 7, payload: '[square-inbox:old-native-token]\nprivate\n[/square-inbox:old-native-token]' }, diagnostic: { residual: 'kept exactly' } };
    insertLedgerRecord(db, 'evidence', native);
    insertLedgerRecord(db, 'evidence', native); // Prior indexed storage preserves duplicates.
    insertLedgerRecord(db, 'evidence', { ...base, activity: 'act/4', kind: 'presentation', outcome: 'presented', at: 9e12, claimToken: 'future-token' });
    setLedgerRevisions(db, { presence: 9, evidence: 17 });
    // Version 1 has exactly the same record authority; version 2 adds only recognition storage/indexing.
    db.exec('DROP TABLE host_native_tokens; DROP INDEX host_evidence_native_token; PRAGMA user_version=1;');
    return { root, file, records: snapshot(db) };
  } finally { db.close(); }
}
function snapshot(db) {
  return {
    presence: db.prepare('SELECT * FROM host_presence ORDER BY seq').all(),
    evidence: db.prepare('SELECT * FROM host_evidence ORDER BY seq').all(),
    meta: db.prepare('SELECT * FROM host_meta').all(),
    sequences: db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
  };
}
function inspect(file, run) { const db = new DatabaseSync(file, { readOnly: true }); try { return run(db); } finally { db.close(); } }

test('explicit offline migrate upgrades prior SQLite while preserving every record, order and observer revision', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const ledger = createHostLedgerPort({ rootPath: f.root });
  await assert.rejects(ledger.listEvidence(), /square ledger migrate/);
  await assert.rejects(verifyHostLedger({ rootPath: f.root }), /square ledger migrate/);
  assert.deepEqual(fs.readFileSync(f.file), before, 'runtime and verify must not silently upgrade');
  const report = await migrateHostLedger({ rootPath: f.root });
  assert.equal(report.status, 'upgraded');
  assert.equal(report.presence, 1);
  assert.equal(report.evidence, 3);
  assert.equal(report.presenceRevision, 9);
  assert.equal(report.evidenceRevision, 17);
  inspect(f.file, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, LEDGER_VERSION);
    assert.deepEqual(snapshot(db), f.records);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_native_tokens').get().n, 0);
    assert.deepEqual(db.prepare('PRAGMA table_info(host_native_tokens)').all().map(row => row.name), ['harness', 'session_key', 'token_key']);
  });
  const upgraded = fs.readFileSync(f.file);
  assert.equal((await migrateHostLedger({ rootPath: f.root })).status, 'sqlite');
  assert.deepEqual(fs.readFileSync(f.file), upgraded, 'current-format migration is an untouched no-op');
});

test('an interrupted schema upgrade rolls back all schema writes without touching old authority', async t => {
  const f = fixture(t);
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
    const result = exec.call(this, sql);
    if (/CREATE TABLE host_native_tokens/.test(sql)) throw new Error('injected schema interruption');
    return result;
  });
  await assert.rejects(migrateHostLedger({ rootPath: f.root }), /upgrade|verification|injected/i);
  inspect(f.file, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(snapshot(db), f.records);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='host_native_tokens'").get().n, 0);
  });
  t.mock.restoreAll();
  assert.equal((await migrateHostLedger({ rootPath: f.root })).status, 'upgraded');
});

test('read-only verify checks recognition codecs without exposing the token', async t => {
  const f = fixture(t);
  await migrateHostLedger({ rootPath: f.root });
  const ledger = createHostLedgerPort({ rootPath: f.root });
  const row = (await ledger.listEvidence({ activity: 'act/2', includeExpired: true }))[0];
  assert.equal(await ledger.retireEvidenceIfUnchanged(row), true);
  assert.equal((await verifyHostLedger({ rootPath: f.root })).status, 'sqlite');
  const db = new DatabaseSync(f.file);
  try { db.prepare('UPDATE host_native_tokens SET token_key=?').run(JSON.stringify('INVALID_TOKEN_SECRET')); }
  finally { db.close(); }
  const before = fs.readFileSync(f.file);
  await assert.rejects(verifyHostLedger({ rootPath: f.root }), error => {
    assert.match(error.message, /database verification failed/);
    assert.doesNotMatch(error.message, /INVALID_TOKEN_SECRET|private|endpoint/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('prior-format corrupt projections refuse upgrade rather than laundering bad indexed authority', async t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.file);
  try { db.exec("UPDATE host_evidence SET outcome='changed' WHERE seq=1"); } finally { db.close(); }
  const before = fs.readFileSync(f.file);
  await assert.rejects(migrateHostLedger({ rootPath: f.root }), /verification|upgrade/i);
  assert.deepEqual(fs.readFileSync(f.file), before);
  inspect(f.file, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1));
});
