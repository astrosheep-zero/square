import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DeliveryLedger } from '../dist/delivery-ledger.js';

const exec = promisify(execFile);
const fixture = new URL('./fixtures/sqlite-runtime.mjs', import.meta.url).pathname;
const runtimes = [{ name: 'Node', executable: process.execPath }];
if (process.env.SQUARE_TEST_BUN) runtimes.push({ name: 'Bun', executable: process.env.SQUARE_TEST_BUN });
for (const runtime of runtimes) test(`${runtime.name} DatabaseSync, v1 plugin loader, and shared Node ledger`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-sqlite-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (mode, generation = '') => exec(runtime.executable, [fixture, mode, root, generation], {
    env: { ...process.env, BUN_BE_BUN: '1' }, timeout: 20000,
  });
  await run('probe');
  const ledger = await DeliveryLedger.open({ location: path.join(root, 'delivery.sqlite') });
  try {
    const owner = 'test:sqlite';
    const session = await ledger.attach({ owner, expectedGeneration: null, routes: [] });
    await ledger.post({ owner, key: 'one', text: 'one card across runtimes' });
    const claim = () => ledger.claimPresentation(owner, { generation: session.generation, budgetChars: 10000 });
    const [children, local] = await Promise.all([
      Promise.all(Array.from({ length: 3 }, () => run('claim', session.generation))),
      (async () => { const batch = await claim(); if (batch) await batch.settle('presented'); return !!batch; })(),
    ]);
    assert.equal(children.filter(result => result.stdout.includes('claimed')).length + Number(local), 1);
    assert.equal((await ledger.receipts(owner)).length, 1);
    assert.equal(await claim(), undefined);
    await ledger.post({ owner, key: 'two', text: 'runtime reads and writes' });
    assert.match((await run('claim', session.generation)).stdout, /claimed/);
    assert.equal((await ledger.receipts(owner)).length, 2);
  } finally { await ledger.close(); }
});
