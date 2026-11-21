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

function bounded(what, promise) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle`)), FAILURE_GUARD_MS);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function settled(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

test('rejects and preserves a text lock, and reacquires after callback failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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

test('creates a SQLite lock database and serializes concurrent holders', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'square.lock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withFileLock } from ${JSON.stringify(lockModuleUrl)};
    await withFileLock(${JSON.stringify(lockPath)}, { retryMs: 5 }, async () => {
      process.stdout.write('locked\\n');
      await new Promise((resolve) => process.stdin.once('data', resolve));
    });
  `], { stdio: ['pipe', 'pipe', 'inherit'] });

  let closeObserved = false;
  const childClose = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closeObserved = true;
      resolve({ code, signal });
    });
  });
  let childError;
  const childFailure = new Promise((resolve) => child.once('error', resolve));
  childFailure.then((error) => { childError = error; });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('locked')) resolve();
    });
    childFailure.then((error) => reject(new Error(`lock child failed before readiness: ${error?.message ?? error}`)));
    childClose.then((outcome) => reject(new Error(`lock child exited before readiness: ${JSON.stringify(outcome)}`)));
  });

  const skipController = new AbortController();
  const waiterController = new AbortController();
  let skip;
  let waiter;
  try {
    await bounded('lock child ready', ready);
    skip = withFileLock(lockPath, { retryMs: 5, skipIfBusy: true, signal: skipController.signal }, () => assert.fail('busy callback'));
    const skipped = await bounded('held-lock skipIfBusy', settled(skip));
    assert.equal(skipped.error, undefined);
    assert.equal(skipped.value, undefined);

    let entered = false;
    waiter = withFileLock(lockPath, { retryMs: 5, createParent: false, signal: waiterController.signal }, () => {
      entered = true;
      return 'acquired';
    });
    child.stdin.end('release\n');
    const acquired = await bounded('lock waiter acquisition', settled(waiter));
    assert.equal(acquired.error, undefined);
    assert.equal(acquired.value, 'acquired');
    assert.equal(entered, true);
    assert.deepEqual(await bounded('lock child exit', childClose), { code: 0, signal: null });
    assert.equal(childError, undefined);

    const database = new DatabaseSync(lockPath, { readOnly: true });
    try {
      assert.equal(
        database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
          .get('table', '__agent_delivery_lock')?.name,
        '__agent_delivery_lock',
      );
    } finally {
      database.close();
    }
  } finally {
    skipController.abort(new Error('test cleanup: skip'));
    waiterController.abort(new Error('test cleanup: waiter'));
    child.stdin.destroy();
    child.stdout.destroy();
    if (!closeObserved) child.kill();
    try {
      if (skip !== undefined) await bounded('held-lock skipIfBusy cleanup', settled(skip));
    } finally {
      try {
        if (waiter !== undefined) await bounded('lock waiter cleanup', settled(waiter));
      } finally {
        if (!closeObserved) await bounded('lock child cleanup', childClose);
      }
    }
  }
});

test('abort interrupts busy retry without entering the critical section', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'square.lock');
  let releaseHolder;
  const release = new Promise((resolve) => { releaseHolder = resolve; });
  let holderStarted = false;
  let holderEntered;
  const entered = new Promise((resolve) => {
    holderEntered = () => {
      holderStarted = true;
      resolve();
    };
  });
  const holderController = new AbortController();
  const holder = withFileLock(lockPath, { retryMs: 5, signal: holderController.signal }, async () => {
    holderEntered();
    await release;
    return 'held';
  });
  const holderOutcome = settled(holder);
  const holderEntry = Promise.race([
    entered,
    holderOutcome.then((outcome) => {
      if (outcome.error) throw outcome.error;
      throw new Error('lock holder settled before entry');
    }),
  ]);
  let contender;
  let contenderEntered = false;
  const controller = new AbortController();
  const reason = new Error('cancel busy retry');
  try {
    await bounded('lock holder entry', holderEntry);
    contender = withFileLock(lockPath, { retryMs: 5, createParent: false, signal: controller.signal }, () => {
      contenderEntered = true;
    });
    controller.abort(reason);
    const aborted = await bounded('lock contender abort', settled(contender));
    assert.equal(aborted.value, undefined);
    assert.ok(aborted.error === reason || aborted.error?.cause === reason);
    assert.equal(contenderEntered, false);
  } finally {
    releaseHolder();
    try {
      if (contender !== undefined) await bounded('lock contender cleanup', settled(contender));
    } finally {
      holderController.abort(new Error('test cleanup: holder'));
      if (holderStarted) {
        const held = await bounded('lock holder release', holderOutcome);
        assert.equal(held.value, 'held');
      } else {
        await bounded('lock holder release', holderOutcome);
      }
    }
  }
  assert.equal(await withFileLock(lockPath, { retryMs: 5 }, () => 'reacquired'), 'reacquired');
});
