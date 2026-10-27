import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_USER_VERSION } from '../dist/square-sqlite.js';
import { createArtifactPort, createSquareFile, diagnoseSquareFile, readSquareSnapshot, writeSquareFile } from '../dist/artifact.js';

const empty = () => ({ hardCap: null, preamble: ['topic'], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
function location(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-rows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'square #? [名].square');
}
async function cells(t) {
  const file = location(t);
  await createSquareFile(file, empty());
  const ports = [createArtifactPort(':memory:', empty()), createArtifactPort(file)];
  t.after(() => Promise.all(ports.map(p => p.close())));
  return ports;
}

test('new artifacts own only the closed current schema, preserve explicit import facts and rebuild in place', async t => {
  const file = location(t), state = empty();
  const weird = 'A\u0000\ud800';
  state.acts = [
    { kind: 'say', actor: weird, body: '\udfff\u0000', at: 0.5, index: 2 },
    { kind: 'hold', at: -2.5, index: 4 },
    { kind: 'resume', at: 7, index: 6 },
  ];
  state.runtime.nextActIndex = 10;
  state.runtime.observations = { [weird]: { 'act/8': { state: 'seen', at: 0.25 } }, dormant: { 'act/1': { state: 'seen', at: -0.5 } } };
  state.runtime.leases = { DORMANT: { leaseId: '\ud800\u0000', heartbeatAt: 1.25, expiresAt: 2.75 } };
  assert.equal(await createSquareFile(file, state), true);
  assert.deepEqual((await readSquareSnapshot(file)).state, state);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_USER_VERSION);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='routes'").get().n, 0);
    assert.deepEqual(JSON.parse(db.prepare('SELECT payload_json FROM activities WHERE act_index=2').get().payload_json), { body: '\udfff\u0000' });
  } finally { db.close(); }
  assert.deepEqual(await diagnoseSquareFile(file), { problems: [], standingCount: 0 });
  const inode = fs.statSync(file).ino;
  assert.equal(await createSquareFile(file, empty()), false);
  await writeSquareFile(file, empty());
  assert.equal(fs.statSync(file).ino, inode);
  assert.equal((await readSquareSnapshot(file)).revision, 1);
});

test('memory and file callbacks are synchronous, atomic, ordered, detached and expire after completion', async t => {
  for (const port of await cells(t)) {
    const body = { channel: 'test', session: 'alice' };
    let escaped;
    const joined = await port.transactAs({ kind: 'join', participant: 'Alice', body }, facts => {
      escaped = facts;
      return facts.land({ kind: 'join', actor: 'Alice', at: 1 });
    });
    const aliceSeat = (await port.read(facts => facts.seat('Alice'))).value;
    assert.equal(joined.version, 1);
    assert.equal(joined.changed, true);
    assert.equal(joined.value.index, 0);
    assert.throws(() => escaped.header(), /expired/);
    assert.throws(() => escaped.land({ kind: 'join', actor: 'Alice', at: 2 }), /expired/);
    assert.throws(() => { joined.value.index = 9; }, TypeError);
    assert.equal((await port.read(r => r.participant('alice'))).value.name, 'Alice');
    assert.equal((await port.transactAs({ kind: 'participant', seat: aliceSeat }, () => 'no-op')).changed, false);

    const original = new Error('no such file: callback-owned failure');
    await assert.rejects(port.transactAs({ kind: 'participant', seat: aliceSeat }, w => { w.land({ kind: 'done', actor: 'Alice', at: 2 }); throw original; }), e => e === original);
    await assert.rejects(port.transactAs({ kind: 'participant', seat: aliceSeat }, async w => { w.land({ kind: 'done', actor: 'Alice', at: 2 }); throw new Error('async rejection'); }), /synchronous/);
    await assert.rejects(port.transactAs({ kind: 'participant', seat: aliceSeat }, w => { w.markSeen('Alice', [100], 2); }), /unassigned/);
    assert.equal(await port.revision(), 1);
    assert.equal((await port.read(r => r.participant('Alice'))).value.joined, true);
    await port.read(() => { assert.throws(() => port.read(r => r.header()), /cannot nest/); });
    const first = port.transactAs({ kind: 'participant', seat: aliceSeat }, w => w.land({ kind: 'done', actor: 'Alice', at: 3 }));
    const next = port.read(r => r.participant('Alice'));
    await first;
    assert.equal((await next).value.done, true);
  }
});

test('settlement has a bounded independent lifetime without losing authority or close fences', { timeout: 15_000 }, async t => {
  const file = location(t);
  await createSquareFile(file, empty());
  const controller = new AbortController();
  const port = createArtifactPort(file, undefined, controller.signal), peer = createArtifactPort(file);
  t.after(() => Promise.all([port.close(), peer.close()]));
  await port.transactAs({ kind: 'join', participant: 'Alice', body: { channel: 'test', session: 'alice' } },
    facts => facts.land({ kind: 'join', actor: 'Alice', at: 1 }));
  const seat = (await port.read(facts => facts.seat('Alice'))).value;
  const authority = { kind: 'participant', seat };
  const cancelled = new Error('pre-effect work cancelled');
  controller.abort(cancelled);
  await assert.rejects(port.read(facts => facts.header()), error => error === cancelled);
  const blocker = new DatabaseSync(file);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    await assert.rejects(port.settleAs(authority, () => assert.fail('locked settlement cannot run')), { name: 'TimeoutError' });
  } finally { blocker.exec('ROLLBACK'); blocker.close(); }
  // The timeout neither poisons the connection nor removes the normal cancellation boundary.
  assert.equal((await port.settleAs(authority, facts => facts.markSeen('Alice', [0], 2))).value, 1);
  await assert.rejects(port.transactAs(authority, () => assert.fail('normal work stays cancelled')), error => error === cancelled);
  await peer.transactAs(authority, facts => facts.land({ kind: 'done', actor: 'Alice', at: 3 }));
  await assert.rejects(port.settleAs(authority, () => assert.fail('retired seats cannot settle')), error => error.code === 'already_joined');
  await port.close();
  await assert.rejects(port.settleAs(authority, () => assert.fail('closed port cannot settle')), /closed/);
});

test('exact canonical receipts, immutable first timestamps and small-value no-op writes preserve revision', async t => {
  for (const port of await cells(t)) {
    const aliceBody = { channel: 'test', session: 'alice' }, bobBody = { channel: 'test', session: 'bob' };
    await port.transactAs({ kind: 'join', participant: 'Alice', body: aliceBody }, facts => facts.land({ kind: 'join', actor: 'Alice', at: 0 }));
    await port.transactAs({ kind: 'join', participant: 'Bob', body: bobBody }, facts => facts.land({ kind: 'join', actor: 'Bob', at: 1 }));
    const alice = (await port.read(facts => facts.seat('Alice'))).value;
    const l = { leaseId: 'one', heartbeatAt: 2, expiresAt: 3, filter: { participants: ['Bob'], mention: 'Alice' } };
    await port.transactAs({ kind: 'participant', seat: alice }, w => { assert.equal(w.markSeen('ALICE', [0, 1], 1.5), 2); assert.equal(w.putLease('alice', l), true); });
    const unchanged = await port.transactAs({ kind: 'participant', seat: alice }, w => {
      assert.equal(w.markSeen('alice', [0, 1], 100), 0);
      assert.equal(w.putLease('ALICE', { ...l, filter: { mention: 'Alice', participants: ['Bob'] } }), false);
      assert.equal(w.removeLease('Alice', 'wrong'), false);
      return w.receipt('ALICE', 0);
    });
    assert.equal(unchanged.changed, false);
    assert.deepEqual(unchanged.value, { at: 1.5 });
    assert.equal((await port.read(r => r.receiptAssignments())).value[0].owner, 'Alice');
    assert.equal((await port.transactAs({ kind: 'participant', seat: alice }, w => w.removeLease('Alice', 'one'))).value, true);
  }
});

test('known legacy and unsupported framing refuse writes without changing bytes; missing paths stay missing', async t => {
  const file = location(t), db = new DatabaseSync(file);
  db.exec('PRAGMA application_id=1397838405; PRAGMA user_version=1; CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL)');
  db.close();
  const before = fs.readFileSync(file), port = createArtifactPort(file);
  t.after(() => port.close());
  await assert.rejects(port.read(r => r.header()), e => {
    assert.equal(e.code, 'invalid_args');
    assert.equal(e.facts?.reason, 'migration_required');
    assert.match(e.message, /Stop sessions.*back it up.*migrate and verify/);
    assert.doesNotMatch(e.message, /square --|--location/);
    return true;
  });
  await assert.rejects(writeSquareFile(file, empty()), /migration/);
  const diagnosis = await diagnoseSquareFile(file);
  assert.match(diagnosis.migrationRequired, /migrate/);
  assert.equal(diagnosis.unfixable, undefined);
  assert.deepEqual(fs.readFileSync(file), before);
  const malformed = new DatabaseSync(file);
  try { malformed.exec('CREATE TABLE extra(note TEXT)'); } finally { malformed.close(); }
  await assert.rejects(port.revision(), e => e.code === 'invalid_args' && e.facts?.reason !== 'migration_required');
  const missing = location(t), absent = createArtifactPort(missing);
  t.after(() => absent.close());
  let called = false;
  await assert.rejects(absent.transactAs({ kind: 'join', participant: 'Alice', body: { channel: 'test', session: 'alice' } }, () => { called = true; }), e => e.code === 'not_found');
  assert.equal(called, false);
  assert.equal(fs.existsSync(missing), false);
});

test('selected-row corruption is isolated from header reads, while doctor inspects unrelated authority and indices', async t => {
  const file = location(t);
  await createSquareFile(file, empty());
  const port = createArtifactPort(file);
  t.after(() => port.close());
  const corruptState = { ...empty(), acts: [{ kind: 'join', actor: 'Alice', at: 0, index: 0 }] };
  corruptState.runtime.nextActIndex = 1;
  await writeSquareFile(file, corruptState);
  const db = new DatabaseSync(file);
  try { db.prepare('UPDATE activities SET payload_json=? WHERE act_index=0').run('{"body":123}'); }
  finally { db.close(); }
  assert.equal((await port.read(r => r.header())).value.lastActIndex, 0);
  await assert.rejects(port.read(r => r.activity(0)), /malformed/);
  assert.match((await diagnoseSquareFile(file)).unfixable, /malformed/);
  await writeSquareFile(file, empty());
  const aliceBody = { channel: 'test', session: 'alice' };
  await port.transactAs({ kind: 'join', participant: 'Alice', body: aliceBody }, w => w.land({ kind: 'join', actor: 'Alice', at: 1 }));
  const corrupt = new DatabaseSync(file);
  try { corrupt.exec('UPDATE participants SET say_count=3'); } finally { corrupt.close(); }
  assert.match((await diagnoseSquareFile(file)).unfixable, /participants.*inconsistent/);
});
