import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withFileLock } from '../dist/file-lock.js';

test('a stale lock owned by a live process is not reclaimed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-'));
  const lockPath = path.join(root, 'square.lock');
  const controller = new AbortController();
  let entered = false;
  fs.writeFileSync(lockPath, `${process.pid}\n${Date.now() - 10_000}\nheld-by-test\n`);
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, old, old);
  const pending = withFileLock(lockPath, { retryMs: 1, staleMs: 1, signal: controller.signal }, async () => {
    entered = true;
  });
  setTimeout(() => controller.abort(new Error('test timeout')), 30);
  await assert.rejects(pending, (error) => error?.cause?.message === 'test timeout');
  assert.equal(entered, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('serializes a lock across processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-process-'));
  const lockPath = path.join(root, 'square.lock');
  const moduleUrl = new URL('../dist/file-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withFileLock } from ${JSON.stringify(moduleUrl)};
    await withFileLock(${JSON.stringify(lockPath)}, { retryMs: 1, staleMs: 1 }, async () => {
      console.log('locked');
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
    });
    const started = Date.now();
    await withFileLock(lockPath, { retryMs: 1, staleMs: 1 }, async () => {});
    assert.ok(Date.now() - started >= 100);
    await new Promise((resolve) => child.once('close', resolve));
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
