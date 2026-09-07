import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createSquareState, loadSquare, probeSquare, writeSquareFile } from '../dist/artifact.js';
import { createFileCell } from '../dist/square-storage.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const CLI = path.join(ROOT, 'dist', 'square.js');

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function makeSquare(t, state = undefined) {
  const dir = makeDir(t);
  const squarePath = path.join(dir, 'SQUARE.square');
  await writeSquareFile(squarePath, state ?? await createSquareState({ force: true, hardCap: null }, 'SQLite test'));
  return squarePath;
}

async function makeAliceSquare(t) {
  const state = await createSquareState({ force: true, hardCap: null }, 'SQLite test');
  state.acts.push({ kind: 'join', actor: 'Alice', at: 0, index: 0 });
  state.runtime.nextActIndex = 1;
  return makeSquare(t, state);
}

function runNode(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...options.env },
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ child, status, signal, stdout, stderr }));
    child.stdin?.end(options.input ?? '');
  });
}

function startNode(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

async function untilOutput(child, expected, timeoutMs = 2_000) {
  let output = '';
  const seen = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(expected)) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error('child exited before ' + expected + ': ' + (code ?? signal))));
  });
  await Promise.race([
    seen,
    sleep(timeoutMs).then(() => { throw new Error('timed out waiting for ' + expected + '; saw ' + output); }),
  ]);
}

async function settlesWithin(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    sleep(timeoutMs).then(() => { throw new Error(message); }),
  ]);
}

test('concurrent processes retain every activity while readers observe only validated snapshots', async (t) => {
  const squarePath = await makeAliceSquare(t);
  const writers = Array.from({ length: 12 }, (_, index) =>
    runNode(path.join(FIXTURES, 'sqlite-square-writer.js'), [squarePath, 'Alice', 'concurrent-' + index]),
  );
  const readerCells = Array.from({ length: 3 }, () => createFileCell(squarePath));
  t.after(async () => Promise.all(readerCells.map((cell) => cell.close())));
  const readers = readerCells.map(async (cell) => {
    for (let index = 0; index < 30; index += 1) {
      const snapshot = await cell.read();
      assert.equal(snapshot.state.runtime.nextActIndex >= snapshot.state.acts.length, true);
      await sleep(2);
    }
  });

  const [results] = await Promise.all([Promise.all(writers), Promise.all(readers)]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const persisted = await loadSquare(squarePath);
  const bodies = persisted.acts.filter((act) => act.kind === 'say').map((act) => act.body).sort();
  assert.deepEqual(bodies, Array.from({ length: 12 }, (_, index) => 'concurrent-' + index).sort());
  assert.deepEqual(persisted.acts.map((act) => act.index), Array.from({ length: persisted.acts.length }, (_, index) => index));
});

test('simultaneous non-force builds produce exactly one SQLite square', async (t) => {
  const dir = makeDir(t);
  const squarePath = path.join(dir, 'SQUARE.square');
  const results = await Promise.all(Array.from(
    { length: 8 },
    () => runNode(path.join(FIXTURES, 'sqlite-square-build.js'), [squarePath]),
  ));
  const successful = results.filter((result) => result.status === 0);
  const conflicts = results.filter((result) => result.status !== 0);
  assert.equal(successful.length, 1, results.map((result) => result.stderr).join('\n'));
  assert.equal(conflicts.length, 7);
  for (const conflict of conflicts) {
    assert.match(conflict.stderr, /Cannot build over an existing square/);
  }
  assert.equal((await loadSquare(squarePath)).preamble[0], 'SQLite build race');
  assert.equal(fs.existsSync(squarePath + '.lock'), false);
});

test('failed or killed initial creators never publish a partial square and leave creation retryable', async (t) => {
  const initializationDir = makeDir(t);
  const initializationPath = path.join(initializationDir, 'initialization-failure.square');
  const initialization = await runNode(
    path.join(FIXTURES, 'sqlite-initialization-failure.js'),
    [initializationPath],
  );
  assert.equal(initialization.status, 0, initialization.stderr);
  assert.match(initialization.stdout, /initialization-failed-before-publication/);
  assert.equal(fs.existsSync(initializationPath), false);
  const retriedInitialization = await runNode(path.join(FIXTURES, 'sqlite-square-build.js'), [initializationPath]);
  assert.equal(retriedInitialization.status, 0, retriedInitialization.stderr);
  assert.equal((await loadSquare(initializationPath)).preamble[0], 'SQLite build race');

  const killedDir = makeDir(t);
  const killedPath = path.join(killedDir, 'killed-before-publication.square');
  const creator = startNode(path.join(FIXTURES, 'sqlite-prepublication-kill.js'), [killedPath]);
  t.after(() => { if (!creator.killed) creator.kill('SIGKILL'); });
  await untilOutput(creator, 'ready-before-publication');
  assert.equal(fs.existsSync(killedPath), false, 'destination appeared before publication');
  creator.kill('SIGKILL');
  const termination = await new Promise((resolve) => creator.once('close', (status, signal) => resolve({ status, signal })));
  assert.equal(termination.signal, 'SIGKILL');
  assert.equal(fs.existsSync(killedPath), false, 'killed creator left a public destination');
  const retriedKilled = await runNode(path.join(FIXTURES, 'sqlite-square-build.js'), [killedPath]);
  assert.equal(retriedKilled.status, 0, retriedKilled.stderr);
  assert.equal((await loadSquare(killedPath)).preamble[0], 'SQLite build race');
});

test('SIGKILL during an uncommitted SQLite write recovers the last committed snapshot', async (t) => {
  const squarePath = await makeSquare(t);
  const committed = await loadSquare(squarePath);
  const child = startNode(
    path.join(FIXTURES, 'sqlite-uncommitted-writer.js'),
    [squarePath, JSON.stringify({ ...committed, preamble: ['uncommitted replacement'] })],
  );
  t.after(() => { if (!child.killed) child.kill('SIGKILL'); });
  await untilOutput(child, 'transaction-open');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  assert.deepEqual(await loadSquare(squarePath), committed);
});

test('already-open cells observe cross-process commits and an in-place force rebuild by revision', async (t) => {
  const squarePath = await makeAliceSquare(t);
  const cell = createFileCell(squarePath);
  t.after(() => cell.close());
  const initial = await cell.read();
  const before = fs.statSync(squarePath);

  const writer = runNode(path.join(FIXTURES, 'sqlite-square-writer.js'), [squarePath, 'Alice', 'cross-process']);
  assert.equal(await cell.changed(initial.version, 3_000), true);
  assert.equal((await writer).status, 0);
  const afterWrite = await cell.read();
  assert.ok(afterWrite.version > initial.version);
  assert.equal(afterWrite.state.acts.at(-1)?.body, 'cross-process');

  const rebuilt = await runNode(CLI, ['build', '--location', squarePath, '--force'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    input: 'Force rebuild context\n',
  });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(await cell.changed(afterWrite.version, 3_000), true);
  const afterRebuild = await cell.read();
  assert.ok(afterRebuild.version > afterWrite.version);
  assert.equal(fs.statSync(squarePath).ino, before.ino);
});

test('a held reader makes COMMIT retry asynchronously, runs the callback once, and releases cleanly', async (t) => {
  const squarePath = await makeSquare(t);
  const reader = new DatabaseSync(squarePath, { readOnly: true });
  let readerClosed = false;
  const cell = createFileCell(squarePath);
  t.after(async () => {
    try { reader.exec('ROLLBACK'); } catch { /* already released */ }
    if (!readerClosed) reader.close();
    await cell.close();
  });
  reader.exec('BEGIN');
  reader.prepare('SELECT state FROM square_snapshot WHERE id = 1').get();

  let calls = 0;
  let settled = false;
  const commit = cell.transact((state) => {
    calls += 1;
    return { state: { ...state, preamble: ['commit after reader'] }, result: undefined };
  }).then(() => { settled = true; });
  let immediateRan = false;
  setImmediate(() => { immediateRan = true; });
  await sleep(50);
  assert.equal(calls, 1);
  assert.equal(settled, false);
  assert.equal(immediateRan, true, 'a busy COMMIT blocked the event loop instead of backing off asynchronously');

  reader.exec('ROLLBACK');
  reader.close();
  readerClosed = true;
  await settlesWithin(commit, 3_000, 'COMMIT did not finish after the held reader released');
  assert.equal((await loadSquare(squarePath)).preamble[0], 'commit after reader');
});

test('an exclusive writer makes ordinary reads wait asynchronously and then return after release', async (t) => {
  const squarePath = await makeSquare(t);
  const writer = new DatabaseSync(squarePath);
  const cell = createFileCell(squarePath);
  let writerClosed = false;
  t.after(async () => {
    try { writer.exec('ROLLBACK'); } catch { /* already released */ }
    if (!writerClosed) writer.close();
    await cell.close();
  });

  const expected = await cell.read();
  writer.exec('BEGIN EXCLUSIVE');
  let settled = false;
  const pending = cell.read().then((snapshot) => { settled = true; return snapshot; });
  let immediateRan = false;
  setImmediate(() => { immediateRan = true; });
  await sleep(50);
  assert.equal(settled, false);
  assert.equal(immediateRan, true, 'an exclusive-reader retry blocked the event loop');

  writer.exec('ROLLBACK');
  writer.close();
  writerClosed = true;
  assert.deepEqual(await settlesWithin(pending, 3_000, 'read did not finish after exclusive lock release'), expected);
});

test('exclusive lock leaves probe and changed bounded, and close cancels a pending read', async (t) => {
  const squarePath = await makeSquare(t);
  const writer = new DatabaseSync(squarePath);
  const cell = createFileCell(squarePath);
  let writerClosed = false;
  t.after(async () => {
    try { writer.exec('ROLLBACK'); } catch { /* already released */ }
    if (!writerClosed) writer.close();
    await cell.close();
  });
  const baseline = (await cell.read()).version;
  writer.exec('BEGIN EXCLUSIVE');

  const probeStarted = Date.now();
  assert.equal(await probeSquare(squarePath), undefined);
  assert.ok(Date.now() - probeStarted < 500, 'probe was not bounded by an exclusive writer');
  const started = Date.now();
  assert.equal(await cell.changed(baseline, 50), false);
  assert.ok(Date.now() - started < 500, 'changed timeout was not bounded');

  const pendingRead = cell.read().then(
    () => new Error('pending read unexpectedly completed while the exclusive lock remained held'),
    (error) => error,
  );
  const closing = cell.close();
  const [readFailure] = await settlesWithin(Promise.all([pendingRead, closing]), 500, 'close left a pending read orphaned');
  assert.match(String(readFailure), /closed/i);
  writer.exec('ROLLBACK');
  writer.close();
  writerClosed = true;
});

test('rejected async callbacks do not commit or leak unhandled rejections in memory or file cells', async (t) => {
  const squarePath = await makeSquare(t);
  const before = await loadSquare(squarePath);
  for (const kind of ['memory', 'file']) {
    const result = await runNode(path.join(FIXTURES, 'sqlite-async-transition.js'), kind === 'file' ? [kind, squarePath] : [kind]);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(await loadSquare(squarePath), before);
});
