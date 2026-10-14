import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSquareFile, readSquareSnapshot } from '../dist/artifact.js';
import { createFileCell } from '../dist/square-storage.js';

const root = path.resolve(import.meta.dirname, '..');
const initial = () => ({ hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-row-lifecycle-'));
  const file = path.join(dir, 'test.square');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await createSquareFile(file, initial());
  const port = createFileCell(file);
  t.after(() => port.close());
  return { file, port };
}
function child(script, file) {
  const process = spawn(globalThis.process.execPath, ['--import', './test/sandbox-env.js', '--input-type=module', '-e', script, file], { cwd: root, env: { ...globalThis.process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  process.stdout.setEncoding('utf8'); process.stderr.setEncoding('utf8');
  process.stdout.on('data', s => { out += s; }); process.stderr.on('data', s => { err += s; });
  const exited = new Promise((resolve, reject) => { process.once('error', reject); process.once('close', (code, signal) => resolve({ code, signal, out, err })); });
  return { process, exited };
}
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('probe did not become ready'); await sleep(10); }
}

test('a blocked COMMIT retries the same callback/result and releases the event loop', async t => {
  const { file, port } = await fixture(t);
  const reader = new DatabaseSync(file, { readOnly: true });
  t.after(() => reader.close());
  reader.exec('BEGIN'); reader.prepare('SELECT revision FROM square_meta').get();
  let calls = 0, finished = false;
  const pending = port.transact(w => { calls++; return w.land({ kind: 'join', actor: 'Alice', at: 0 }); }).then(r => { finished = true; return r; });
  await until(() => calls === 1);
  await sleep(40);
  assert.equal(finished, false);
  assert.equal(calls, 1);
  reader.exec('ROLLBACK');
  const result = await pending;
  assert.equal(result.value.index, 0);
  assert.equal(result.version, 1);
  assert.equal(calls, 1);
});

test('abort while COMMIT is busy rolls back all landing effects and preserves the caller reason', async t => {
  const { file, port } = await fixture(t), reader = new DatabaseSync(file, { readOnly: true });
  t.after(() => reader.close());
  reader.exec('BEGIN'); reader.prepare('SELECT revision FROM square_meta').get();
  const abort = new AbortController(), reason = new Error('stop commit');
  let calls = 0;
  const pending = assert.rejects(port.transact(w => { calls++; w.land({ kind: 'join', actor: 'Alice', at: 0 }); }, abort.signal), e => e === reason);
  await until(() => calls === 1);
  abort.abort(reason);
  await pending;
  reader.exec('ROLLBACK');
  const header = (await port.read(r => r.header())).value;
  assert.equal(header.nextActIndex, 0);
  assert.equal(await port.revision(), 0);
  assert.deepEqual((await port.read(r => r.roster())).value, []);
});

test('exclusive lock acquisition is cancellable before callback; close drains work and stops changed waits', async t => {
  const { file, port } = await fixture(t), writer = new DatabaseSync(file);
  t.after(() => writer.close());
  await port.revision();
  writer.exec('BEGIN EXCLUSIVE');
  const abort = new AbortController(), reason = new Error('stop acquisition');
  let calls = 0;
  const pending = assert.rejects(port.read(r => { calls++; return r.header(); }, abort.signal), e => e === reason);
  await sleep(40); abort.abort(reason); await pending;
  assert.equal(calls, 0);
  const waiting = port.changed(0, 60000);
  const reading = assert.rejects(port.read(r => r.header()), /closed/);
  await sleep(30);
  await port.close();
  await reading;
  assert.equal(await waiting, false);
  writer.exec('ROLLBACK');
  await port.close();
});

test('two processes serialize unseen selection plus sparse receipt insertion without double consumption', async t => {
  const { file, port } = await fixture(t);
  await port.transact(w => {
    w.land({ kind: 'join', actor: 'Alice', at: 0 }); w.land({ kind: 'join', actor: 'Bob', at: 1 });
    w.land({ kind: 'say', actor: 'Alice', at: 2, body: 'one', mentions: ['Bob'] });
  });
  const script = `import {createFileCell} from './dist/square-storage.js';
    const p=createFileCell(process.argv[1]);
    const result=await p.transact(w=>{const ids=w.directed('Bob',{unseenOnly:true},{edge:'oldest',limit:10}).items.map(h=>h.index);w.markSeen('Bob',ids,3);return ids;});
    console.log(JSON.stringify(result));await p.close();`;
  const outcomes = await Promise.all([child(script, file).exited, child(script, file).exited]);
  for (const o of outcomes) assert.equal(o.code, 0, o.err);
  const results = outcomes.map(o => JSON.parse(o.out));
  assert.deepEqual(results.flatMap(r => r.value), [2]);
  assert.deepEqual(results.map(r => r.changed).sort(), [false, true]);
  assert.equal(await port.revision(), 2);
});

test('process death before commit recovers authority and derived landing indices together', async t => {
  const { file, port } = await fixture(t);
  await port.transact(w => { w.land({ kind: 'join', actor: 'Alice', at: 0 }); w.land({ kind: 'join', actor: 'Bob', at: 1 }); });
  const before = await readSquareSnapshot(file);
  const script = `import {createFileCell} from './dist/square-storage.js';
    const p=createFileCell(process.argv[1]);await p.transact(w=>{w.land({kind:'say',actor:'Alice',body:'uncommitted',mentions:['Bob'],at:2});process.stdout.write('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  const running = child(script, file);
  t.after(() => { if (!running.process.killed) running.process.kill('SIGKILL'); });
  let ready = false; running.process.stdout.on('data', s => { if (s.includes('ready')) ready = true; });
  await until(() => ready);
  running.process.kill('SIGKILL');
  assert.equal((await running.exited).signal, 'SIGKILL');
  assert.deepEqual(await readSquareSnapshot(file), before);
  assert.deepEqual((await port.read(r => r.directed('Bob', {}, { edge: 'oldest', limit: 10 }))).value.items, []);
});

test('idle revision discovery has a positive control and never selects historical bodies', async t => {
  const { file, port } = await fixture(t);
  await port.transact(w => {
    for (let i = 0; i < 128; i++) w.land({ kind: 'say', actor: 'Alice', at: i, body: 'history '.repeat(128) });
  });
  const queries = [], prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) { queries.push(sql); return prepare.call(this, sql, ...args); });
  assert.equal(await port.changed(1, 80), false);
  assert.ok(queries.some(sql => /FROM square_meta/i.test(sql)), 'must actually observe authoritative revision');
  assert.equal(queries.some(sql => /payload_json|SELECT \* FROM activities/i.test(sql)), false);
  const writer = createFileCell(file);
  t.after(() => writer.close());
  await writer.transact(w => w.land({ kind: 'join', actor: 'Bob', at: 200 }));
  assert.equal(await port.changed(1, 1000), true);
});
