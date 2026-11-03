import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { observeClaudeDelivery, nativePayload } from '../dist/claude-delivery.js';
import { hashPayload } from '../dist/claude-transport.js';
import { harnessOwner } from '../dist/owner.js';

test('native admission is distinct from exact stored presentation, even after rotation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-claude-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { SQUARE_DELIVERY: path.join(root, 'delivery.sqlite') };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  t.after(() => ledger.close());
  const owner = harnessOwner({ channel: 'claude-code', session: 'session' });
  const route = { kind: 'claude-native', address: { sessionId: 'session' } };
  const session = await ledger.attach({ owner, expectedGeneration: null, routes: [route] });
  await ledger.post({ owner, key: 'producer:1', text: 'real text' });
  let payload;
  await ledger.dispatchHandoff(owner, 'producer:1', { kind: 'claude-native', async send(card, _address, context) {
    payload = nativePayload(context.token, card.text);
    assert.equal(await context.prepare({ token: context.token, payloadHash: hashPayload(payload) }), true);
    return 'unknown';
  } }, { generation: session.generation, timeoutMs: 1000 });
  const wrong = await observeClaudeDelivery('session', payload.replace('real text', 'changed'), 'guard', env);
  assert.deepEqual(wrong, { recognized: true, current: false });
  const guard = await observeClaudeDelivery('session', payload, 'guard', env);
  assert.equal(guard.current, true);
  await ledger.attach({ owner, expectedGeneration: session.generation, routes: [route] });
  assert.equal((await observeClaudeDelivery('session', payload, 'admitted', env, guard.refs)).current, true);
  assert.equal((await ledger.receipts(owner)).length, 0);
  assert.equal((await observeClaudeDelivery('session', payload.replace('real text', 'changed'), 'stored', env)).current, false);
  assert.equal((await ledger.receipts(owner)).length, 0);
  assert.equal((await observeClaudeDelivery('session', payload, 'stored', env)).current, true);
  assert.equal((await ledger.receipts(owner)).length, 1);
});


test('cancellation fences native guard but cannot erase already admitted evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-claude-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { SQUARE_DELIVERY: path.join(root, 'delivery.sqlite') };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  t.after(() => ledger.close());
  const owner = harnessOwner({ channel: 'claude-code', session: 'session' });
  const session = await ledger.attach({ owner, expectedGeneration: null, routes: [{ kind: 'claude-native', address: {} }] });
  await ledger.post({ owner, key: 'producer:1', text: 'native text' });
  let payload;
  await ledger.dispatchHandoff(owner, 'producer:1', { kind: 'claude-native', async send(card, _address, context) {
    payload = nativePayload(context.token, card.text);
    await context.prepare({ token: context.token, payloadHash: hashPayload(payload) });
    return 'unknown';
  } }, { generation: session.generation, timeoutMs: 1000 });
  const guard = await observeClaudeDelivery('session', payload, 'guard', env);
  assert.equal(guard.current, true);
  await ledger.cancel({ owner, generation: session.generation });
  assert.equal((await observeClaudeDelivery('session', payload, 'guard', env)).current, false);
  assert.equal((await observeClaudeDelivery('session', payload, 'admitted', env, guard.refs)).current, true);
  assert.equal((await ledger.receipts(owner)).length, 0);
});
