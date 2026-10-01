import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { observeFileVersion, observeFileMetadata } from '../dist/file-changes.js';
import { createSquareState, writeSquareFile } from '../dist/artifact.js';
import { createFileCell } from '../dist/square-storage.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-change-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'SQUARE.square');
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
  return { callbacks, closed: () => closed };
}

test('canonical subscribers share watcher and read; abort/close stay local and final release disposes it', async (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'test');
  const alias = file + '.alias';
  fs.symlinkSync(file, alias);
  const watcher = fakeWatch(t);
  let reads = 0;
  let value = 0;
  const read = async () => { reads++; return value; };
  const first = await observeFileVersion(file, 'test', read);
  const second = await observeFileVersion(alias, 'test', read);
  t.after(() => { first.close(); second.close(); });
  assert.equal(watcher.callbacks.length, 1);
  assert.deepEqual(await Promise.all([first.read(), second.read()]), [0, 0]);
  assert.equal(reads, 1);
  const cancel = new AbortController();
  const reason = new Error('only first subscriber');
  const aborted = assert.rejects(first.changed(0, Infinity, cancel.signal), (error) => error === reason);
  const remaining = second.changed(0, 1_000);
  cancel.abort(reason);
  await aborted;
  first.close();
  assert.equal(watcher.closed(), 0);
  value = 1;
  watcher.callbacks[0]('change', path.basename(file));
  assert.equal(await remaining, true);
  assert.equal(reads, 2);
  const closing = second.changed(1, Infinity);
  second.close();
  assert.equal(await closing, false);
  assert.equal(watcher.closed(), 1);
});

test('an edge during a shared read is rechecked, including a waiter arriving after the edge', async (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'test');
  const watcher = fakeWatch(t);
  let release;
  let reads = 0;
  const observer = await observeFileVersion(file, 'race', async () => {
    if (++reads === 1) return new Promise((resolve) => { release = resolve; });
    return 1;
  });
  t.after(() => observer.close());
  const initial = observer.read();
  watcher.callbacks[0]('change', path.basename(file));
  const waiting = observer.changed(0, 300);
  release(0);
  assert.equal(await initial, 0);
  assert.equal(await waiting, true);
  assert.equal(reads, 2);
});

test('unavailable watches reconcile without loading history', async (t) => {
  const file = fixture(t);
  await writeSquareFile(file, await createSquareState({ force: true, hardCap: null }, 'fallback'));
  t.mock.method(fs, 'watch', () => { throw Object.assign(new Error('no watcher capacity'), { code: 'ENOSPC' }); });
  const cell = createFileCell(file);
  t.after(() => cell.close());
  const baseline = (await cell.read()).version;
  const waiting = cell.changed(baseline, 4_000);
  await sleep(40);
  await cell.transact((state) => ({ state: { ...state, preamble: ['changed without notification'] }, result: undefined }));
  assert.equal(await waiting, true);
});

test('a healthy watcher that loses an event still reconciles, without speculative changes', async (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'first');
  fakeWatch(t);
  const observer = await observeFileMetadata(file);
  t.after(() => observer.close());
  const baseline = await observer.read();
  const changed = observer.changed(baseline, 4_000);
  await sleep(30);
  fs.writeFileSync(file, 'different, but no event is emitted');
  assert.equal(await changed, true);
});

test('directory observation survives atomic replacement and ignores unrelated filenames', async (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'before');
  const observer = await observeFileMetadata(file);
  t.after(() => observer.close());
  const before = await observer.read();
  const unchanged = observer.changed(before, 80);
  fs.writeFileSync(path.join(path.dirname(file), 'irrelevant'), 'noise');
  assert.equal(await unchanged, false);
  const waiting = observer.changed(before, 3_000);
  fs.writeFileSync(file + '.tmp', 'replacement with different size');
  fs.renameSync(file + '.tmp', file);
  assert.equal(await waiting, true);
});
