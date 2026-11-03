import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { deliveryFrameOverhead, renderDeliveryReminder } from '../dist/delivery-frame.js';
import { codexHookResponse, runCodexHook } from '../dist/codex-hook.js';
import { harnessOwner } from '../dist/owner.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-codex-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'), SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json') };
  const owner = harnessOwner({ channel: 'codex', session: 'thread' });
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  t.after(() => ledger.close());
  await ledger.attach({ owner, expectedGeneration: null, routes: [] });
  await ledger.post({ owner, key: 'fixture:1', text: 'hello from a producer' });
  return { env, ledger, owner, input: { session_id: 'thread', hook_event_name: 'PostToolUse' } };
}

test('Codex confirms only after the output sink accepts the response', async t => {
  const { env, ledger, owner, input } = await fixture(t);
  let output;
  await codexHookResponse(input, async text => {
    assert.equal((await ledger.receipts(owner)).length, 0);
    output = JSON.parse(text);
  }, env, () => {});
  assert.equal(output.hookSpecificOutput.additionalContext, renderDeliveryReminder(['hello from a producer'], { tagged: true }));
  assert.equal((await ledger.receipts(owner)).length, 1);
  assert.equal(await runCodexHook(JSON.stringify(input), env, () => assert.fail('already presented')), '');
});

test('Codex reserves the reminder frame within its context budget', async t => {
  const { env, ledger, owner, input } = await fixture(t);
  const remaining = 1200 - deliveryFrameOverhead({ tagged: true }) - 'hello from a producer'.length - 2;
  await ledger.post({ owner, key: 'fixture:2', text: 'x'.repeat(remaining) });
  await ledger.post({ owner, key: 'fixture:3', text: 'later' });
  let output;
  await codexHookResponse(input, text => { output = JSON.parse(text); }, env, () => {});
  assert.equal(output.hookSpecificOutput.additionalContext.length, 1200);
  assert.deepEqual((await ledger.receipts(owner)).map(receipt => receipt.key).sort(), ['fixture:1', 'fixture:2']);
});

test('the actual CLI writes one hook response before recording its receipt', async t => {
  const { env, ledger, owner, input } = await fixture(t);
  const cli = fileURLToPath(new URL('../dist/square.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'codex-hook'], { input: JSON.stringify(input), encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /hello from a producer/);
  assert.equal((await ledger.receipts(owner)).length, 1);
  const second = spawnSync(process.execPath, [cli, 'codex-hook'], { input: JSON.stringify(input), encoding: 'utf8', env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '');
});

test('missing output sink never consumes, and an uncertain sink never creates a receipt', async t => {
  const { env, ledger, owner, input } = await fixture(t);
  await codexHookResponse(input, undefined, env, () => {});
  assert.equal((await ledger.receipts(owner)).length, 0);
  await codexHookResponse(input, () => { throw new Error('stdout failed'); }, env, () => {});
  assert.equal((await ledger.receipts(owner)).length, 0);
  assert.ok((await ledger.health(owner)).unknownAttempts.length);
});
