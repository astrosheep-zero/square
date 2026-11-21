import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileLockError, withFileLock } from '../dist/packages/agent-delivery/src/file-lock.js';

const lockModuleUrl = new URL('../dist/packages/agent-delivery/src/file-lock.js', import.meta.url).href;
const FAILURE_GUARD_MS = 10_000;

function bounded(promise) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('file-lock fixture did not settle')), FAILURE_GUARD_MS);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function lockRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('rejects an invalid lock, preserves its bytes, and reacquires after callback failure', async t => {
  const root = lockRoot(t);
  const invalid = path.join(root, 'invalid.lock');
  const original = `${process.pid}\n${Date.now() - 10_000}\nheld-by-test\n`;
  fs.writeFileSync(invalid, original);
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(invalid, old, old);
  await assert.rejects(
    withFileLock(invalid, { retryMs: 1, skipIfBusy: true }, () => assert.fail('invalid lock callback')),
    (error) => error instanceof FileLockError && error.code === 'not_a_database',
  );
  assert.equal(fs.readFileSync(invalid, 'utf8'), original);

  const lockPath = path.join(root, 'square.lock');
  await assert.rejects(withFileLock(lockPath, { retryMs: 1, skipIfBusy: true }, () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(await withFileLock(lockPath, { retryMs: 1, skipIfBusy: true }, () => 'released after failure'), 'released after failure');
});

test('a real held lock skips or serializes a waiter and distinguishes close from error', async t => {
  const lockPath = path.join(lockRoot(t), 'square.lock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withFileLock } from ${JSON.stringify(lockModuleUrl)};
    await withFileLock(${JSON.stringify(lockPath)}, { retryMs: 5 }, async () => {
      process.stdout.write('locked\\n');
      await new Promise((resolve) => process.stdin.once('data', resolve));
    });
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  const close = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const failure = new Promise((resolve) => child.once('error', resolve));
  let childError;
  failure.then((error) => { childError = error; });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (data) => { output += data; if (output.includes('locked')) resolve(); });
    failure.then(reject);
    close.then((outcome) => reject(new Error(`lock child exited before readiness: ${JSON.stringify(outcome)}`)));
  });
  const skipController = new AbortController();
  const waiterController = new AbortController();
  let skip;
  let waiter;
  try {
    await bounded(ready);
    skip = withFileLock(lockPath, { retryMs: 5, skipIfBusy: true, signal: skipController.signal }, () => assert.fail('busy callback'));
    assert.equal(await bounded(skip), undefined);

    let entered = false;
    waiter = withFileLock(lockPath, { retryMs: 5, createParent: false, signal: waiterController.signal }, () => {
      entered = true;
      return 'acquired';
    });
    child.stdin.end('release\n');
    assert.equal(await bounded(waiter), 'acquired');
    assert.equal(entered, true);
    assert.deepEqual(await bounded(close), { code: 0, signal: null });
    assert.equal(childError, undefined);

    const database = new DatabaseSync(lockPath, { readOnly: true });
    try {
      assert.equal(
        database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', '__agent_delivery_lock')?.name,
        '__agent_delivery_lock',
      );
    } finally { database.close(); }
  } finally {
    skipController.abort(new Error('test cleanup: skip'));
    waiterController.abort(new Error('test cleanup: waiter'));
    child.stdin.destroy();
    child.stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const outcomes = await bounded(Promise.allSettled([close, ...(skip === undefined ? [] : [skip]), ...(waiter === undefined ? [] : [waiter])]));
    assert.equal(outcomes[0].status, 'fulfilled', outcomes[0].reason);
  }
});

test('abort interrupts a busy retry without entering the critical section', async t => {
  const lockPath = path.join(lockRoot(t), 'square.lock');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let ready;
  const entered = new Promise((resolve) => { ready = resolve; });
  let holderStarted = false;
  const holderController = new AbortController();
  const holder = withFileLock(lockPath, { retryMs: 5, signal: holderController.signal }, async () => {
    holderStarted = true;
    ready();
    await held;
    return 'held';
  });
  const controller = new AbortController();
  const reason = new Error('cancel busy retry');
  let contender;
  let contenderEntered = false;
  try {
    await bounded(Promise.race([entered, holder]));
    assert.equal(holderStarted, true, 'lock holder entered');
    contender = withFileLock(lockPath, { retryMs: 5, createParent: false, signal: controller.signal }, () => {
      contenderEntered = true;
    });
    controller.abort(reason);
    await bounded(assert.rejects(contender, (error) => error === reason || error?.cause === reason));
    assert.equal(contenderEntered, false);
  } finally {
    release();
    controller.abort(reason);
    holderController.abort(new Error('test cleanup: holder'));
    const outcomes = await bounded(Promise.allSettled([holder, ...(contender === undefined ? [] : [contender])]));
    if (holderStarted) {
      if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
      assert.equal(outcomes[0].value, 'held');
    }
  }
  assert.equal(await bounded(withFileLock(lockPath, { retryMs: 5 }, () => 'reacquired')), 'reacquired');
});
