import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { LEDGER_FILENAME, insertLedgerRecord } from '../dist/host-ledger-sqlite.js';

async function fixture(t, populated = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-observers-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => 100 });
  const record = { location: path.join(root, 'test.square'), participant: 'Alice', session: 'one', channel: 'pi', updatedAt: 100 };
  if (populated) assert.equal((await ledger.ensurePresence(record)).status, 'ensured');
  return { root, file: path.join(root, LEDGER_FILENAME), ledger, record };
}

function fakeWatch(t) {
  const callbacks = [];
  let closed = 0;
  t.mock.method(fs, 'watch', (_directory, callback) => {
    callbacks.push(callback);
    const watcher = new EventEmitter();
    watcher.close = () => { closed++; };
    return watcher;
  });
  return {
    callbacks, closed: () => closed,
    hint: () => callbacks.forEach((callback) => callback('change', LEDGER_FILENAME)),
  };
}

function closePair(pair) { pair.presence.close(); pair.evidence.close(); }
async function pairValues(pair) { return Promise.all([pair.presence.read(), pair.evidence.read()]); }

function sqlConnections(t, file) {
  const connections = new Set();
  for (const method of ['prepare', 'exec', 'close']) {
    const original = DatabaseSync.prototype[method];
    t.mock.method(DatabaseSync.prototype, method, function (...args) {
      if (this.location() === file) connections.add(this);
      return original.apply(this, args);
    });
  }
  return connections;
}

test('presence and evidence observers expose distinct committed revisions, never attempted mutations', async (t) => {
  const { file, ledger, record } = await fixture(t);
  const watch = fakeWatch(t);
  const changes = await ledger.observeChanges();
  t.after(() => closePair(changes));
  const before = await pairValues(changes);

  await ledger.ensurePresence({ ...record, participant: 'Bob' });
  watch.hint();
  const presenceOnly = await pairValues(changes);
  assert.notEqual(presenceOnly[0], before[0]);
  assert.equal(presenceOnly[1], before[1]);

  const input = { location: record.location, participant: 'Alice', session: 'one', activity: 'act/2', kind: 'presentation', now: 100 };
  const claim = await ledger.claimEvidence({ ...input, leaseMs: 1_000 });
  assert.equal(claim.status, 'acquired');
  await ledger.appendEvidence({ ...input, claimToken: claim.claimToken, at: 100, outcome: 'failed' });
  watch.hint();
  const evidenceOnly = await pairValues(changes);
  assert.equal(evidenceOnly[0], presenceOnly[0], 'our own failed injection must not look like a presence change');
  assert.notEqual(evidenceOnly[1], presenceOnly[1]);

  const exec = DatabaseSync.prototype.exec;
  const error = new Error('injected COMMIT I/O failure');
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (this.location() === file && sql === 'COMMIT') throw error;
    return exec.call(this, sql);
  });
  assert.equal((await ledger.ensurePresence({ ...record, participant: 'Carol' })).status, 'degraded');
  t.mock.restoreAll();
  // fakeWatch is restored too; its captured callback remains a valid hint source.
  watch.hint();
  assert.deepEqual(await pairValues(changes), evidenceOnly);
  await ledger.appendEvidence({ ...input, claimToken: 'not-the-owner', at: 100, outcome: 'presented' });
  watch.hint();
  assert.deepEqual(await pairValues(changes), evidenceOnly, 'token-fenced no-op leaves both revisions unchanged');
});

test('shared category reads open once for changed metadata and open no SQL after unchanged hints or reconciliation', async (t) => {
  const { file, ledger, record } = await fixture(t);
  const watch = fakeWatch(t);
  const first = await ledger.observeChanges();
  const second = await new FileHostLedgerPort({ rootPath: path.dirname(file) }).observeChanges();
  t.after(() => { closePair(first); closePair(second); });
  const connections = sqlConnections(t, file);
  const initial = await Promise.all([pairValues(first), pairValues(second)]);
  assert.deepEqual(initial[0], initial[1]);
  assert.equal(connections.size, 1, 'both categories and subscribers share one revision-pair snapshot');
  connections.clear();

  watch.hint();
  assert.deepEqual(await pairValues(first), initial[0]);
  assert.equal(connections.size, 0, 'a filesystem hint alone does not open SQLite');
  const generation = first.presence.generation;
  await sleep(2_200); // Exercise the real hint-loss reconciliation tick, not only synthetic hints.
  assert.ok(first.presence.generation > generation, 'reconciliation really occurred');
  assert.deepEqual(await pairValues(second), initial[1]);
  assert.equal(connections.size, 0, 'unchanged reconciliation does not open SQLite');

  await ledger.ensurePresence({ ...record, participant: 'Bob' });
  connections.clear(); // Do not mistake the writer for the observer's read.
  watch.hint();
  const updated = await Promise.all([pairValues(first), pairValues(second)]);
  assert.equal(connections.size, 1, 'the positive control detects exactly one shared SQL connection');
  assert.notEqual(updated[0][0], initial[0][0]);
  assert.equal(updated[0][1], initial[0][1]);
  assert.deepEqual(updated[0], updated[1]);
});

test('a mutation during revision-read completion is not cached against later metadata', async (t) => {
  const { file, ledger, record } = await fixture(t);
  const watch = fakeWatch(t);
  const changes = await ledger.observeChanges();
  t.after(() => closePair(changes));
  const db = new DatabaseSync(file, { readOnly: true });
  const revision = db.prepare('SELECT presence_revision FROM host_meta WHERE id=1').get().presence_revision;
  db.close();
  let mutate = true;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    const target = this.location() === file;
    close.call(this);
    if (!target || !mutate) return;
    mutate = false;
    // The original read transaction has closed; another writer commits before
    // its promise resolves. A post-read metadata capture would swallow this edge.
    const writer = new DatabaseSync(file);
    try {
      writer.exec('BEGIN IMMEDIATE');
      insertLedgerRecord(writer, 'presence', { ...record, participant: 'Bob', v: 1 });
      writer.exec('UPDATE host_meta SET presence_revision=presence_revision+1 WHERE id=1; COMMIT');
    } finally { writer.close(); }
    watch.hint();
  });
  const first = await changes.presence.read();
  assert.ok([String(revision), String(revision + 1)].includes(first), 'the first inspection may already recheck the raced metadata');
  assert.equal(mutate, false, 'the mutation happened in the intended read-completion gap');
  assert.equal(await changes.presence.read(), String(revision + 1));
});

test('missing database is a stable read-only state and its appearance wakes both categories', async (t) => {
  const { root, file, ledger, record } = await fixture(t, false);
  const watch = fakeWatch(t);
  const changes = await ledger.observeChanges();
  t.after(() => closePair(changes));
  const missing = await pairValues(changes);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(root), []);
  watch.hint();
  assert.deepEqual(await pairValues(changes), missing);
  assert.equal(fs.existsSync(file), false);

  const waiting = [changes.presence.changed(missing[0], 3_000), changes.evidence.changed(missing[1], 3_000)];
  assert.equal((await ledger.ensurePresence(record)).status, 'ensured');
  watch.hint();
  assert.deepEqual(await Promise.all(waiting), [true, true]);
  const appeared = await pairValues(changes);
  assert.notEqual(appeared[0], missing[0]);
  assert.notEqual(appeared[1], missing[1], 'missing is distinct from revision zero');
});

test('last category close cancels a busy shared revision read and closes its connection without another retry', async (t) => {
  const { file, ledger } = await fixture(t);
  fakeWatch(t);
  const changes = await ledger.observeChanges();
  t.after(() => closePair(changes));
  const prepare = DatabaseSync.prototype.prepare;
  const close = DatabaseSync.prototype.close;
  let attempts = 0;
  let ready, retired;
  const retrying = new Promise((resolve) => { ready = resolve; });
  const closed = new Promise((resolve) => { retired = resolve; });
  const connections = new Set();
  const closedConnections = new Set();
  const busyFault = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (this.location() === file && /PRAGMA application_id/.test(sql)) {
      connections.add(this);
      if (++attempts === 2) ready();
      throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    }
    return prepare.call(this, sql, ...args);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    if (connections.has(this)) { closedConnections.add(this); retired(); }
    return close.call(this);
  });
  const cancelledPresence = assert.rejects(changes.presence.read(), /closed/);
  let timeout;
  try {
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('shared revision connection outlived its final subscriber')), 1_000); });
    await Promise.race([retrying, deadline]);
    changes.presence.close();
    await cancelledPresence;
    assert.equal(closedConnections.size, 0, 'the evidence category still owns the shared read');
    const cancelledEvidence = assert.rejects(changes.evidence.read(), /closed/);
    changes.evidence.close();
    await cancelledEvidence;
    await Promise.race([closed, deadline]);
    assert.equal(connections.size, 1, 'the positive control observed a real shared SQLite retry loop');
    assert.equal(closedConnections.size, 1);
    const stoppedAt = attempts;
    await sleep(80); // More than two retry ticks, while the busy fault remains armed.
    assert.equal(attempts, stoppedAt, 'closing all observers must stop background busy retries');
  } finally {
    clearTimeout(timeout);
    closePair(changes);
    // A regression must fail boundedly rather than leave its uncancelled retry
    // running forever after the assertion. This does not make the test pass.
    busyFault.mock.restore();
  }
});

test('failed shared reads are not cached and subscriber cancellation/refcounts stay independent', async (t) => {
  const { file, ledger, record } = await fixture(t);
  const watch = fakeWatch(t);
  const first = await ledger.observeChanges();
  const second = await ledger.observeChanges();
  t.after(() => { closePair(first); closePair(second); });
  assert.equal(watch.callbacks.length, 1);
  const exec = DatabaseSync.prototype.exec;
  const error = new Error('transient revision read failure');
  let failures = 0;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (this.location() === file && sql === 'BEGIN' && failures++ === 0) throw error;
    return exec.call(this, sql);
  });
  await assert.rejects(first.presence.read(), (caught) => caught === error);
  const baseline = await second.presence.read();
  assert.notEqual(baseline, undefined, 'same metadata is retried after a failure');
  const controller = new AbortController();
  const reason = new Error('cancel only first subscriber');
  const aborted = assert.rejects(first.presence.changed(baseline, Infinity, controller.signal), (caught) => caught === reason);
  const surviving = second.presence.changed(baseline, 3_000);
  controller.abort(reason);
  await aborted;
  closePair(first);
  assert.equal(watch.closed(), 0);
  assert.equal((await ledger.ensurePresence({ ...record, participant: 'Bob' })).status, 'ensured');
  watch.hint();
  assert.equal(await surviving, true);
  second.presence.close();
  assert.equal(watch.closed(), 0, 'evidence category still owns a reference');
  second.evidence.close();
  assert.equal(watch.closed(), 1, 'final category release closes the shared watcher');
  closePair(second);
  assert.equal(watch.closed(), 1, 'close is idempotent');
});
