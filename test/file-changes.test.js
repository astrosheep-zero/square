import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeFileVersion, observeFileMetadata } from '../dist/storage/file-changes.js';
import { createArtifactPort, prepareSquareBuild, writeSquareFile, observeSquareRevision } from '../dist/artifact/artifact.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-change-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'SQUARE.square');
}

function fakeWatch(t, { unavailable = false } = {}) {
  const callbacks = [];
  let closed = 0;
  let failing = unavailable;
  t.mock.method(fs, 'watch', (_directory, callback) => {
    if (failing) throw Object.assign(new Error('no watcher capacity'), { code: 'ENOSPC' });
    callbacks.push(callback);
    const watcher = new EventEmitter();
    watcher.close = () => { closed++; };
    return watcher;
  });
  return { callbacks, closed: () => closed, recover: () => { failing = false; } };
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

test('an unavailable watcher recovers a real commit through the fallback interval', async (t) => {
  const file = fixture(t);
  await writeSquareFile(file, await prepareSquareBuild({ force: true, hardCap: null }, 'fallback'));
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(fs, 'watch', () => { throw Object.assign(new Error('no watcher capacity'), { code: 'ENOSPC' }); });
  const observer = await observeSquareRevision(file);
  const cell = createArtifactPort(file);
  t.after(async () => { await cell.close(); observer.close(); });
  const baseline = await observer.read();
  const waiting = observer.changed(baseline, 4_000);
  await cell.transactAs({ kind: 'join', participant: 'Alice', owner: ':' },
    facts => facts.land({ kind: 'join', actor: 'Alice', at: 1 }));
  t.mock.timers.tick(2_000);
  assert.equal(await waiting, true);
  assert.equal(await observer.read(), 1);
});

test('a missing revision stays quiet, then appears and disappears on real filesystem edges', async (t) => {
  const file = fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const watcher = fakeWatch(t, { unavailable: true });
  const first = await observeSquareRevision(file);
  assert.equal(await first.read(), null);
  const controller = new AbortController();
  const reason = new Error('caller stopped waiting');
  const cancelled = assert.rejects(first.changed(null, Infinity, controller.signal), (error) => error === reason);
  t.mock.timers.tick(2_000);
  assert.equal(await first.read(), null);
  controller.abort(reason);
  await cancelled;
  first.close();

  watcher.recover();
  const observer = await observeSquareRevision(file);
  t.after(() => observer.close());
  const appeared = observer.changed(null, 4_000);
  await writeSquareFile(file, await prepareSquareBuild({ force: true, hardCap: null }, 'returned'));
  watcher.callbacks.at(-1)('rename', path.basename(file));
  assert.equal(await appeared, true);
  assert.equal(await observer.read(), 0);

  const removed = observer.changed(0, 4_000);
  fs.unlinkSync(file);
  watcher.callbacks.at(-1)('rename', path.basename(file));
  assert.equal(await removed, true);
  assert.equal(await observer.read(), null);

  fs.writeFileSync(file, 'not a database');
  watcher.callbacks.at(-1)('change', path.basename(file));
  await assert.rejects(observer.read(), { code: 'invalid_args' });
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
