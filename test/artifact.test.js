import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSquareFile, diagnoseSquareFile, readSquareSnapshot, writeSquareFile } from '../dist/artifact.js';
import { createFileCell, createMemoryCell } from '../dist/square-storage.js';

const empty = () => ({ hardCap: null, preamble: ['topic'], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
function location(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-rows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'square #? [名].square');
}
async function cells(t) {
  const file = location(t);
  await createSquareFile(file, empty());
  const ports = [createMemoryCell(empty()), createFileCell(file)];
  t.after(() => Promise.all(ports.map(p => p.close())));
  return ports;
}

test('new artifacts own only the closed v2 schema, preserve explicit import facts and rebuild in place', async t => {
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
  state.routes = [0, 1].map(() => ({ location: '', participant: weird, sessionId: '\ud800', channel: '', kind: 'paseo', address: { '\ud800': '\u0000' }, updatedAt: 3.5, epoch: { value: 4.25 }, other: ['extra', '\udfff'] }));
  assert.equal(await createSquareFile(file, state), true);
  assert.deepEqual((await readSquareSnapshot(file)).state, state);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='square_snapshot'").get().n, 0);
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
    let escaped;
    const joined = await port.transact(facts => {
      escaped = facts;
      facts.land({ kind: 'join', actor: 'Alice', at: 1 });
      return facts.participant('ALICE');
    });
    assert.equal(joined.version, 1);
    assert.equal(joined.changed, true);
    assert.equal(joined.value.name, 'Alice');
    assert.throws(() => escaped.header(), /expired/);
    assert.throws(() => escaped.land({ kind: 'done', actor: 'Alice', at: 2 }), /expired/);
    assert.throws(() => { joined.value.name = 'changed'; }, TypeError);
    assert.equal((await port.read(r => r.participant('alice'))).value.name, 'Alice');
    assert.equal((await port.transact(() => 'no-op')).changed, false);

    const original = new Error('no such file: callback-owned failure');
    await assert.rejects(port.transact(w => { w.land({ kind: 'done', actor: 'Alice', at: 2 }); throw original; }), e => e === original);
    await assert.rejects(port.transact(async w => { w.land({ kind: 'done', actor: 'Alice', at: 2 }); throw new Error('async rejection'); }), /synchronous/);
    await assert.rejects(port.transact(w => { w.land({ kind: 'done', actor: 'Alice', at: 2 }); try { w.markSeen('Alice', [100], 2); } catch {} }), /unassigned/);
    assert.equal(await port.revision(), 1);
    assert.equal((await port.read(r => r.participant('Alice'))).value.joined, true);
    await port.read(() => { assert.throws(() => port.read(r => r.header()), /cannot nest/); });
    const first = port.transact(w => w.land({ kind: 'done', actor: 'Alice', at: 3 }));
    const next = port.read(r => r.participant('Alice'));
    await first;
    assert.equal((await next).value.done, true);
  }
});

test('exact canonical receipts, immutable first timestamps and small-value no-op writes preserve revision', async t => {
  for (const port of await cells(t)) {
    await port.transact(w => { w.land({ kind: 'join', actor: 'Alice', at: 0 }); w.land({ kind: 'join', actor: 'Bob', at: 1 }); });
    const l = { leaseId: 'one', heartbeatAt: 2, expiresAt: 3, filter: { participants: ['Bob'], mention: 'Alice' } };
    await port.transact(w => { assert.equal(w.markSeen('ALICE', [0, 1], 1.5), 2); assert.equal(w.putLease('alice', l), true); });
    const unchanged = await port.transact(w => {
      assert.equal(w.markSeen('alice', [0, 1], 100), 0);
      assert.equal(w.putLease('ALICE', { ...l, filter: { mention: 'Alice', participants: ['Bob'] } }), false);
      assert.equal(w.removeLease('Alice', 'wrong'), false);
      return w.receipt('ALICE', 0);
    });
    assert.equal(unchanged.changed, false);
    assert.deepEqual(unchanged.value, { at: 1.5 });
    assert.equal((await port.read(r => r.receiptAssignments())).value[0].owner, 'Alice');
    assert.equal((await port.transact(w => w.removeLease('Alice', 'one'))).value, true);
  }
});

test('known legacy and unsupported framing refuse writes without changing bytes; missing paths stay missing', async t => {
  const file = location(t), db = new DatabaseSync(file);
  db.exec('PRAGMA application_id=1397838405; PRAGMA user_version=1; CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL)');
  db.close();
  const before = fs.readFileSync(file), port = createFileCell(file);
  t.after(() => port.close());
  await assert.rejects(port.read(r => r.header()), e => e.code === 'invalid_args' && e.facts?.reason === 'migration_required' && /migrate/.test(e.message));
  await assert.rejects(writeSquareFile(file, empty()), /migration/);
  const diagnosis = await diagnoseSquareFile(file);
  assert.match(diagnosis.migrationRequired, /migrate/);
  assert.equal(diagnosis.unfixable, undefined);
  assert.deepEqual(fs.readFileSync(file), before);
  const malformed = new DatabaseSync(file);
  try { malformed.exec('CREATE TABLE extra(note TEXT)'); } finally { malformed.close(); }
  await assert.rejects(port.revision(), e => e.code === 'invalid_args' && e.facts?.reason !== 'migration_required');
  const missing = location(t), absent = createFileCell(missing);
  t.after(() => absent.close());
  let called = false;
  await assert.rejects(absent.transact(() => { called = true; }), e => e.code === 'not_found');
  assert.equal(called, false);
  assert.equal(fs.existsSync(missing), false);
});

test('selected-row corruption is isolated from header reads, while doctor inspects unrelated authority and indices', async t => {
  const file = location(t);
  await createSquareFile(file, empty());
  const port = createFileCell(file);
  t.after(() => port.close());
  await port.transact(w => w.land({ kind: 'say', actor: 'Alice', at: 0, body: 'body' }));
  const db = new DatabaseSync(file);
  try { db.prepare('UPDATE activities SET payload_json=? WHERE act_index=0').run('{"body":123}'); }
  finally { db.close(); }
  assert.equal((await port.read(r => r.header())).value.lastActIndex, 0);
  await assert.rejects(port.read(r => r.activity(0)), /malformed/);
  assert.match((await diagnoseSquareFile(file)).unfixable, /malformed/);
  await writeSquareFile(file, empty());
  await port.transact(w => w.land({ kind: 'join', actor: 'Alice', at: 1 }));
  const corrupt = new DatabaseSync(file);
  try { corrupt.exec('UPDATE participants SET say_count=3'); } finally { corrupt.close(); }
  assert.match((await diagnoseSquareFile(file)).unfixable, /participants.*inconsistent/);
});
