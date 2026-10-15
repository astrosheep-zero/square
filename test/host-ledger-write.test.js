import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { LEDGER_FILENAME, insertLedgerRecord } from '../dist/host-ledger-sqlite.js';
import { inSqliteTransaction } from '../dist/sqlite-transaction.js';

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-write-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = new FileHostLedgerPort({ rootPath: root, now: () => 100 });
  const record = { location: path.join(root, 'test.square'), participant: 'Alice', session: 'test', channel: 'pi', updatedAt: 100 };
  assert.equal((await port.ensurePresence(record)).status, 'ensured');
  return { root, port, record, file: path.join(root, LEDGER_FILENAME) };
}

function revisions(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { ...db.prepare('SELECT presence_revision, evidence_revision FROM host_meta WHERE id=1').get() }; }
  finally { db.close(); }
}

function faultExec(t, file, inject) {
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (this.location() === file) inject(sql);
    return exec.call(this, sql);
  });
}
const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

test('non-busy COMMIT failure rolls back both records and revision and surfaces without retry', async (t) => {
  const { port, record, file } = await fixture(t);
  const before = revisions(file);
  const error = new Error('injected SQLite I/O failure');
  let commits = 0;
  faultExec(t, file, (sql) => { if (sql === 'COMMIT') { commits++; throw error; } });
  const result = await port.ensurePresence({ ...record, participant: 'Bob' });
  assert.equal(result.status, 'degraded');
  assert.equal(result.error, error);
  assert.equal(commits, 1);
  assert.deepEqual(revisions(file), before);
  t.mock.restoreAll();
  assert.deepEqual((await port.listPresence()).map((row) => row.participant), ['Alice']);
  assert.equal((await port.ensurePresence({ ...record, participant: 'Bob' })).status, 'ensured');
});

test('busy COMMIT retries the same transaction without rerunning its synchronous callback', async (t) => {
  const { record, file } = await fixture(t);
  let commits = 0;
  faultExec(t, file, (sql) => { if (sql === 'COMMIT' && ++commits <= 2) throw busy(); });
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  let changes = 0;
  const result = await inSqliteTransaction(db, true, () => {}, () => {
    changes++;
    insertLedgerRecord(db, 'presence', { ...record, participant: 'Bob', v: 1 });
    db.exec('UPDATE host_meta SET presence_revision=presence_revision+1 WHERE id=1');
    return 'committed once';
  });
  assert.equal(result, 'committed once');
  assert.equal(changes, 1);
  assert.equal(commits, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_presence').get().n, 2);
  assert.equal(revisions(file).presence_revision, 2);
});

test('cancellation while a claim COMMIT is busy preserves the reason and publishes nothing', async (t) => {
  const { port, record, file } = await fixture(t);
  const before = revisions(file);
  const controller = new AbortController();
  const reason = new Error('cancel pending presence claim');
  let attempts = 0;
  faultExec(t, file, (sql) => {
    if (sql === 'COMMIT') { attempts++; controller.abort(reason); throw busy(); }
  });
  const result = await port.claimPresence({ ...record, participant: 'Bob' }, controller.signal);
  assert.equal(result.status, 'degraded');
  assert.equal(result.error, reason);
  assert.equal(attempts, 1);
  assert.deepEqual(revisions(file), before);
  t.mock.restoreAll();
  assert.deepEqual((await port.listPresence()).map((row) => row.participant), ['Alice']);
  assert.equal((await port.claimPresence({ ...record, participant: 'Bob' })).status, 'acquired', 'cancelled claim releases both locks');
});

test('busy transaction acquisition yields and cancellation never enters the callback', async (t) => {
  const { record, file } = await fixture(t);
  const before = revisions(file);
  const blocker = new DatabaseSync(file);
  const contender = new DatabaseSync(file);
  t.after(() => { blocker.close(); contender.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  const controller = new AbortController();
  const reason = new Error('cancel blocked transaction');
  let calls = 0;
  const pending = inSqliteTransaction(contender, true, () => {}, () => {
    calls++;
    insertLedgerRecord(contender, 'presence', { ...record, participant: 'Bob', v: 1 });
  }, controller.signal);
  const rejected = assert.rejects(pending, (error) => error === reason);
  // A separate connection really holds the write lock; reaching this timer proves
  // lock acquisition yielded rather than blocking Node's event loop.
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort(reason);
  await rejected;
  blocker.exec('ROLLBACK');
  assert.equal(calls, 0);
  assert.deepEqual(revisions(file), before);
});
