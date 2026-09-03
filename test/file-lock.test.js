import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileLockError, withFileLock } from '../dist/file-lock.js';

test('a text lock at the pathname is rejected and preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-'));
  const lockPath = path.join(root, 'square.lock');
  const original = `${process.pid}\n${Date.now() - 10_000}\nheld-by-test\n`;
  fs.writeFileSync(lockPath, original);
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, old, old);

  await assert.rejects(
    withFileLock(lockPath, { retryMs: 1 }, async () => {}),
    (error) => error instanceof FileLockError && error.code === 'not_a_database',
  );
  assert.equal(fs.readFileSync(lockPath, 'utf8'), original);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith('square.lock')),
    ['square.lock'],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('creates a SQLite lock database and serializes concurrent holders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-process-'));
  const lockPath = path.join(root, 'square.lock');
  const moduleUrl = new URL('../dist/file-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withFileLock } from ${JSON.stringify(moduleUrl)};
    await withFileLock(${JSON.stringify(lockPath)}, { retryMs: 1 }, async () => {
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
    await withFileLock(lockPath, { retryMs: 1 }, async () => {});
    assert.ok(Date.now() - started >= 100);
    await new Promise((resolve) => child.once('close', resolve));
  } finally {
    child.kill();
  }

  const database = new DatabaseSync(lockPath, { readOnly: true });
  try {
    assert.equal(
      database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
        .get('table', '__square_file_lock')?.name,
      '__square_file_lock',
    );
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('abort interrupts busy retry without entering the critical section', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-abort-'));
  const lockPath = path.join(root, 'square.lock');
  const moduleUrl = new URL('../dist/file-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withFileLock } from ${JSON.stringify(moduleUrl)};
    await withFileLock(${JSON.stringify(lockPath)}, { retryMs: 1 }, async () => {
      console.log('locked');
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
    });
    const controller = new AbortController();
    let entered = false;
    const pending = withFileLock(lockPath, { retryMs: 1, signal: controller.signal }, async () => {
      entered = true;
    });
    setTimeout(() => controller.abort(new Error('test timeout')), 30);
    await assert.rejects(pending, (error) => error?.cause?.message === 'test timeout' || error?.message === 'test timeout');
    assert.equal(entered, false);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('abort interrupts SQLite busy retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-lock-abort-'));
  const lockPath = path.join(root, 'square.lock');
  const moduleUrl = new URL('../dist/file-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withFileLock } from ${JSON.stringify(moduleUrl)};
    await withFileLock(${JSON.stringify(lockPath)}, { retryMs: 1 }, async () => {
      console.log('locked');
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
    });
    const controller = new AbortController();
    const pending = withFileLock(lockPath, { retryMs: 1, signal: controller.signal }, async () => {});
    setTimeout(() => controller.abort(new Error('test abort')), 25);
    await assert.rejects(pending, (error) => error?.name === 'AbortError' || error?.cause?.message === 'test abort');
    await new Promise((resolve) => child.once('close', resolve));
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
