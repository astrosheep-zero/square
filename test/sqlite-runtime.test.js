import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DeliveryLedger } from '../dist/ledger/delivery-ledger.js';

const exec = promisify(execFile);
const fixture = new URL('./fixtures/sqlite-runtime.mjs', import.meta.url).pathname;
const runtimes = [{ name: 'Node', executable: process.execPath }];
if (process.env.SQUARE_TEST_BUN) runtimes.push({ name: 'Bun', executable: process.env.SQUARE_TEST_BUN });
for (const runtime of runtimes) test(`${runtime.name} legacy loader and shared ledger interoperate with Node`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-sqlite-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'delivery #?.sqlite');
  const ledger = await DeliveryLedger.open({ location });
  t.after(() => ledger.close());
  const run = (mode, generation) => exec(runtime.executable, [fixture, location, generation, mode], {
    env: { ...process.env, BUN_BE_BUN: '1' }, timeout: 20000,
  });
  const owner = 'test:sqlite';
  const session = await ledger.attach({ owner, expectedGeneration: null, routes: [] });
  await ledger.post({ owner, key: ['one'], text: '鱼🐈 one card across runtimes' });
  assert.match((await run('first', session.generation)).stdout, /claimed/);
  assert.deepEqual((await ledger.receipts(owner)).map(receipt => receipt.key), [['one']]);
  await ledger.post({ owner, key: ['two'], text: 'runtime reads and writes' });
  const claim = () => ledger.claimPresentation(owner, { generation: session.generation, budgetChars: 10000 });
  const [child, local] = await Promise.all([
    run('claim', session.generation),
    (async () => { const batch = await claim(); if (batch) await batch.settle('presented'); return !!batch; })(),
  ]);
  assert.equal(Number(child.stdout.includes('claimed')) + Number(local), 1);
  assert.deepEqual((await ledger.receipts(owner)).map(receipt => receipt.key), [['one'], ['two']]);
});
