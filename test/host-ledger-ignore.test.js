import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';

test('single-root presence creates its ignore marker and claims atomically', async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-ignore-'));
  const port = new FileHostLedgerPort({ rootPath: path.join(root, 'ledger') });
  const record = { location: path.join(root, 'test.square'), participant: 'rei', session: 'test', channel: 'pi', updatedAt: Date.now() };
  assert.equal((await port.claimPresence(record)).status, 'acquired');
  assert.equal((await port.claimPresence({ ...record, session: 'other' })).status, 'busy');
  assert.equal(await fs.readFile(path.join(root, 'ledger', '.gitignore'), 'utf8'), '*\n');
});

test('existing single-root ignore files stay untouched', async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-ignore-'));
  const ledgerRoot = path.join(root, 'ledger');
  await fs.mkdir(ledgerRoot, { recursive: true });
  await fs.writeFile(path.join(ledgerRoot, '.gitignore'), 'keep\n');
  const port = new FileHostLedgerPort({ rootPath: ledgerRoot });
  await port.ensurePresence({ location: path.join(root, 'test.square'), participant: 'rei', session: 'test', channel: 'pi', updatedAt: Date.now() });
  assert.equal(await fs.readFile(path.join(ledgerRoot, '.gitignore'), 'utf8'), 'keep\n');
});

test('listing a missing single-root ledger is read-only', async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-ignore-'));
  const ledgerRoot = path.join(root, 'ledger');
  const port = new FileHostLedgerPort({ rootPath: ledgerRoot });
  assert.deepEqual(await port.listPresence(), []);
  assert.equal(fsSync.existsSync(ledgerRoot), false);
});

test('aborting a queued presence claim does not acquire or write an owner', async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-abort-'));
  const ledgerRoot = path.join(root, 'ledger');
  const port = new FileHostLedgerPort({ rootPath: ledgerRoot });
  const { withFileLock } = await import('../dist/file-lock.js');
  const lockPath = path.join(ledgerRoot, 'presence-claim.lock');
  const controller = new AbortController();
  const record = { location: path.join(root, 'test.square'), participant: 'rei', session: 'queued', channel: 'pi', updatedAt: Date.now() };
  const held = withFileLock(lockPath, { retryMs: 10 }, async () => {
    const pending = port.claimPresence(record, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'degraded');
    return result;
  });
  await held;
  assert.equal(fsSync.existsSync(path.join(ledgerRoot, 'presence.ndjsonl')), false);
});
