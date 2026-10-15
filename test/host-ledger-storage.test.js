import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { LEDGER_FILENAME, initializeLedger, insertLedgerRecord } from '../dist/host-ledger-sqlite.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-storage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, LEDGER_FILENAME), location: path.join(root, 'test.square') };
}

// IPC starts both contenders only after both independent runtimes have loaded.
// Keep the winning worker alive until both results arrive, so wake exclusion is
// tested against a live owner, not interrupted-process recovery.
const workerSource = `
  import { FileHostLedgerPort } from ${JSON.stringify(new URL('../dist/host-ledger-file-adapter.js', import.meta.url).href)};
  import { createArtifactPort, createSquareFile } from ${JSON.stringify(new URL('../dist/artifact.js', import.meta.url).href)};
  const [root, location, mode, session] = process.argv.slice(1);
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => 100 });
  process.send({ ready: true });
  process.on('message', async () => {
    try {
      let result;
      if (mode === 'presence') result = await ledger.claimPresence({ location, participant: 'Alice', session, channel: 'pi', updatedAt: 100 });
      else if (mode === 'wake') result = await ledger.claimWakeAttempt({ attention: { squarePath: location, recipient: 'Alice', actIndex: 2 }, session, routeKind: 'paseo', leaseMs: 60_000, now: 100 });
      else {
        await createSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
        const artifact = createArtifactPort(location);
        try {
          result = await ledger.withClaimLock(async () => {
            const presence = await ledger.ensurePresence({ location, participant: 'Alice', session, channel: 'pi', updatedAt: 100 });
            if (presence.status !== 'ensured') throw presence.error;
            await artifact.transact(facts => facts.land({ kind: 'join', actor: 'Alice', at: 100 }));
            const claim = await ledger.claimEvidence({ location, participant: 'Alice', session, activity: 'act/0', kind: 'presentation', leaseMs: 100, now: 100 });
            return { status: claim.status, presenceCount: (await ledger.listPresence()).length, joined: (await artifact.read(facts => facts.participant('Alice'))).value.joined };
          });
        } finally { await artifact.close(); }
      }
      process.send({ result });
    } catch (error) { process.send({ error: error.stack }); }
  });
`;

function worker(t, item, mode, session) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource, item.root, item.location, mode, session], {
    // Inherit the parent's --import sandbox environment, never the real host.
    env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let readyResolve, resultResolve, reject;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const result = new Promise((resolve, fail) => { resultResolve = resolve; reject = fail; });
  const timer = setTimeout(() => { reject(new Error(`ledger worker timed out (${mode}): ${stderr}`)); child.kill(); }, 8_000);
  const exited = new Promise((resolve) => child.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`ledger worker exited (${code}): ${stderr}`));
    readyResolve();
    resolve();
  }));
  child.on('error', (error) => { reject(error); readyResolve(); });
  child.on('message', (message) => {
    if (message.ready) readyResolve();
    else if (message.error) reject(new Error(message.error));
    else { clearTimeout(timer); resultResolve(message.result); }
  });
  // Attach immediately; a startup failure must not become an unhandled rejection.
  result.catch(() => {});
  t.after(async () => { child.kill(); await exited; });
  return { ready, result, start: () => child.send('go') };
}

test('independent processes agree on one presence owner and one attention-wide wake claim', async (t) => {
  for (const mode of ['presence', 'wake']) {
    const item = fixture(t);
    const contenders = ['one', 'two'].map((session) => worker(t, item, mode, session));
    await Promise.all(contenders.map((child) => child.ready));
    contenders.forEach((child) => child.start());
    const results = await Promise.all(contenders.map((child) => child.result));
    assert.deepEqual(results.map((result) => result.status).sort(), ['acquired', 'busy'], mode);
    const ledger = new FileHostLedgerPort({ rootPath: item.root, now: () => 100 });
    const rows = mode === 'presence' ? await ledger.listPresence() : await ledger.listWakeAttempts();
    assert.equal(rows.length, 1, mode);
    assert.equal(rows[0].session, ['one', 'two'][results.findIndex((result) => result.status === 'acquired')]);
  }
});

test('withClaimLock allows nested ledger and artifact work without holding a host database transaction', async (t) => {
  const item = fixture(t);
  const child = worker(t, item, 'nested', 'one');
  await child.ready;
  child.start();
  assert.deepEqual(await child.result, { status: 'acquired', presenceCount: 1, joined: true });
});

test('a preexisting empty database is invalid authority, never silently initialized by runtime', async (t) => {
  const { root, file, location } = fixture(t);
  const db = new DatabaseSync(file);
  db.close();
  const before = fs.readFileSync(file);
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => 100 });
  await assert.rejects(ledger.listPresence({}), /invalid|unsupported/i);
  const result = await ledger.ensurePresence({ location, participant: 'Alice', session: 'one', channel: 'pi', updatedAt: 100 });
  assert.equal(result.status, 'degraded');
  assert.match(result.error.message, /invalid|unsupported/i);
  assert.deepEqual(fs.readFileSync(file), before, 'runtime must not turn a preexisting invalid destination into fresh authority');
});

test('indexed lookups decode only selected records, including time and released visibility', async (t) => {
  const { root, file, location } = fixture(t);
  const now = 10 * 86400000;
  const presence = { v: 1, location, participant: 'Alice', session: 'one', channel: 'pi', updatedAt: now };
  const evidence = { v: 1, location, participant: 'Alice', session: 'one', activity: 'act/2', kind: 'presentation', outcome: 'presented', at: now };
  const db = new DatabaseSync(file);
  try {
    initializeLedger(db);
    insertLedgerRecord(db, 'presence', presence);
    insertLedgerRecord(db, 'evidence', evidence);
    // Every supplied lookup key has an unrelated row. Poison only its payload;
    // derived keys remain intact so SQL can exclude it before codec decoding.
    for (const change of [{ location: path.join(root, 'elsewhere.square') }, { participant: 'Other' }, { session: 'other' }, { updatedAt: now + 1 }, { updatedAt: 0 }]) {
      insertLedgerRecord(db, 'presence', { ...presence, ...change });
    }
    for (const change of [{ location: path.join(root, 'elsewhere.square') }, { participant: 'Other' }, { session: 'other' }, { activity: 'act/3' }, { kind: 'lifecycle' }, { outcome: 'released' }, { at: now + 1 }, { at: 0 }]) {
      insertLedgerRecord(db, 'evidence', { ...evidence, ...change });
    }
    db.exec("UPDATE host_presence SET row_json='{' WHERE seq>1; UPDATE host_evidence SET row_json='{' WHERE seq>1");
  } finally { db.close(); }
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => now });
  const lookup = { location, participant: 'ALICE', session: 'one' };
  assert.deepEqual(await ledger.listPresence(lookup), [presence]);
  assert.deepEqual(await ledger.listEvidence({ ...lookup, kind: 'presentation', activity: 'act/2' }), [evidence]);
  // The poison really is undecodable, rather than accidentally accepted by the
  // codec and hidden by a second JavaScript filter after a whole-ledger read.
  await assert.rejects(ledger.listPresence({}));
  await assert.rejects(ledger.listEvidence({ includeReleased: true }));
});

test('nextExpiry decodes only its session and preserves activation, lease and retention deadlines', async (t) => {
  const { root, file, location } = fixture(t);
  const retention = 7 * 86400000;
  let now = 100;
  const db = new DatabaseSync(file);
  try {
    initializeLedger(db);
    insertLedgerRecord(db, 'presence', { v: 1, location, participant: 'Alice', session: 'one', channel: 'pi', updatedAt: 120 });
    insertLedgerRecord(db, 'evidence', { v: 1, location, participant: 'Alice', session: 'one', activity: 'act/2', kind: 'presentation', outcome: 'dispatching', at: 95, expiresAt: 110 });
    insertLedgerRecord(db, 'evidence', { v: 1, location, participant: 'Alice', session: 'one', activity: 'act/3', kind: 'wake', outcome: 'accepted', at: -retention });
    insertLedgerRecord(db, 'presence', { v: 1, location, participant: 'Other', session: 'other', channel: 'pi', updatedAt: 101 });
    insertLedgerRecord(db, 'evidence', { v: 1, location, participant: 'Other', session: 'other', activity: 'act/2', kind: 'presentation', outcome: 'dispatching', at: 100, expiresAt: 101 });
    db.exec("UPDATE host_presence SET row_json='{' WHERE session_key='\"other\"'; UPDATE host_evidence SET row_json='{' WHERE session_key='\"other\"'");
  } finally { db.close(); }
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => now });
  assert.equal(await ledger.nextExpiry('one'), 110);
  now = 111;
  assert.equal(await ledger.nextExpiry('one'), 120);
  now = 121;
  assert.equal(await ledger.nextExpiry('one'), 95 + retention + 1);
  now = 95 + retention + 1;
  assert.equal(await ledger.nextExpiry('one'), 120 + retention + 1);
  now = 120 + retention + 1;
  assert.equal(await ledger.nextExpiry('one'), Infinity, 'accepted wakes have no retention deadline');
  assert.equal(await ledger.nextExpiry('absent'), Infinity);
});
