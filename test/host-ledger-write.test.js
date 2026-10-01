import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'square-ledger-write-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const port = new FileHostLedgerPort({ rootPath: root });
  const record = { location: path.join(root, 'test.square'), participant: 'Alice', session: 'test', channel: 'pi', updatedAt: Date.now() };
  assert.equal((await port.ensurePresence(record)).status, 'ensured');
  return { root, port, record, presence: path.join(root, 'presence.ndjsonl') };
}

function denied(code) { return Object.assign(new Error(`injected ${code} replacing ledger`), { code }); }

async function assertNoTemps(root) {
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
}

test('transient replacement denial retries one intact snapshot without unlinking the live ledger', async (t) => {
  const { root, port, record, presence } = await fixture(t);
  const before = await fs.readFile(presence, 'utf8');
  const rename = fs.rename;
  let attempts = 0;
  const sources = new Set();
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target !== presence) return rename(source, target);
    sources.add(source);
    attempts += 1;
    if (attempts <= 2) {
      assert.equal(await fs.readFile(presence, 'utf8'), before);
      throw denied(attempts === 1 ? 'EPERM' : 'EACCES');
    }
    return rename(source, target);
  });
  const result = await port.ensurePresence({ ...record, participant: 'Bob' });
  assert.equal(result.status, 'ensured');
  assert.equal(attempts, 3);
  assert.equal(sources.size, 1);
  assert.deepEqual((await port.listPresence()).map((row) => row.participant), ['Alice', 'Bob']);
  await assertNoTemps(root);
});

test('exhausted replacement retries preserve the previous ledger and remove only the candidate file', async (t) => {
  const { root, port, record, presence } = await fixture(t);
  const before = await fs.readFile(presence, 'utf8');
  const rename = fs.rename;
  let attempts = 0;
  const error = denied('EBUSY');
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target !== presence) return rename(source, target);
    attempts += 1;
    throw error;
  });
  const result = await port.ensurePresence({ ...record, participant: 'Bob' });
  assert.equal(result.status, 'degraded');
  assert.equal(result.error, error);
  assert.equal(attempts, 6);
  assert.equal(await fs.readFile(presence, 'utf8'), before);
  await assertNoTemps(root);
});

test('unrelated replacement errors are surfaced immediately without retry or partial publication', async (t) => {
  const { root, port, record, presence } = await fixture(t);
  const before = await fs.readFile(presence, 'utf8');
  const rename = fs.rename;
  let attempts = 0;
  const error = denied('EIO');
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target !== presence) return rename(source, target);
    attempts += 1;
    throw error;
  });
  const result = await port.ensurePresence({ ...record, participant: 'Bob' });
  assert.equal(result.status, 'degraded');
  assert.equal(result.error, error);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(presence, 'utf8'), before);
  await assertNoTemps(root);
});

test('cancellation during a presence-claim replacement retry never publishes the claim', async (t) => {
  const { root, port, record, presence } = await fixture(t);
  const before = await fs.readFile(presence, 'utf8');
  const rename = fs.rename;
  const controller = new AbortController();
  let attempts = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target !== presence) return rename(source, target);
    attempts += 1;
    controller.abort(new Error('cancel claim'));
    throw denied('EPERM');
  });
  const result = await port.claimPresence({ ...record, participant: 'Bob' }, controller.signal);
  assert.equal(result.status, 'degraded');
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(presence, 'utf8'), before);
  await assertNoTemps(root);
});
