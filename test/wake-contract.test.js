import assert from 'node:assert/strict';
import test from 'node:test';

import { createWakeTransport } from '../dist/notifications.js';

const clock = () => 1_700_000_000_000;
const hostLedger = { listPresence: async () => [] };

function request(kind) {
  return {
    location: '/nonexistent/square.square',
    participant: 'Faye',
    activity: 'act/1',
    actor: 'Bev',
    route: {
      location: '/nonexistent/square.square',
      participant: 'Faye',
      sessionId: `${kind}-session`,
      channel: kind,
      kind,
      address: { endpoint: 'endpoint' },
      updatedAt: 1,
    },
  };
}

function adapter(kind, extra = {}) {
  return { kind, async dispatch() { return { outcome: 'accepted' }; }, ...extra };
}

test('injected native transport receives the full request without an awareness payload', async () => {
  const nativeRequest = request('claude-native');
  const beforeSend = async () => true;
  const native = {
    async probe(route) { assert.equal(route, nativeRequest.route); return true; },
    async attempt(actual, timeoutMs, gate) {
      assert.equal(actual, nativeRequest);
      assert.equal(timeoutMs, 100);
      assert.equal(gate, beforeSend);
      return { outcome: 'unknown' };
    },
  };
  const transport = createWakeTransport([], hostLedger, clock, { 'claude-native': native });
  assert.equal(await transport.probe(nativeRequest.route), true);
  assert.deepEqual(await transport.attempt(nativeRequest, 100, beforeSend), { outcome: 'unknown' });
});

test('supplied final gate alone owns transport revalidation without another artifact or ledger observation', async () => {
  const unreadableLedger = new Proxy({}, { get() { throw new Error('transport must not read the ledger with a supplied gate'); } });
  let gates = 0;
  const gate = async () => { gates += 1; return true; };
  const gated = adapter('paseo', {
    async dispatch(_address, payload, finalGate) {
      assert.equal(finalGate, gate);
      assert.match(payload, /attention: act\/1 for Faye from Bev/);
      assert.equal(await finalGate(), true);
      return { outcome: 'accepted' };
    },
  });
  assert.deepEqual(await createWakeTransport([gated], unreadableLedger, clock).attempt(request('paseo'), 100, gate), { outcome: 'accepted' });
  assert.equal(gates, 1);
});

test('standalone native dispatch receives the same fresh projection gate', async () => {
  let gated = false;
  const native = { async attempt(_request, _timeout, finalGate) {
    assert.equal(await finalGate(), false); // unavailable artifact is never permission to send
    gated = true;
    return { outcome: 'unknown' };
  } };
  await createWakeTransport([], hostLedger, clock, { 'claude-native': native }).attempt(request('claude-native'), 100);
  assert.equal(gated, true);
});

test('wake transport reports not-capable when no adapter owns the route kind', async () => {
  const transport = createWakeTransport([], hostLedger, clock, {});
  assert.deepEqual(await transport.probe(request('codex-queue').route), { outcome: 'not-capable', diagnostic: 'no adapter for codex-queue' });
  assert.deepEqual(await transport.attempt(request('codex-queue'), 100), { outcome: 'not-capable', diagnostic: 'no adapter for codex-queue' });
});

test('wake transport probe uses the adapter probe when present and assumes capable otherwise', async () => {
  const probed = [];
  const withProbe = adapter('paseo', { async probe(address) { probed.push(address); return false; } });
  assert.equal(await createWakeTransport([withProbe], hostLedger, clock, {}).probe(request('paseo').route), false);
  assert.deepEqual(probed, [{ endpoint: 'endpoint' }]);
  assert.equal(await createWakeTransport([adapter('codex-queue')], hostLedger, clock, {}).probe(request('codex-queue').route), true);
});

test('wake transport reports a probe failure as not-capable with its diagnostic', async () => {
  const failing = adapter('paseo', { async probe() { throw new Error('daemon down'); } });
  assert.deepEqual(await createWakeTransport([failing], hostLedger, clock, {}).probe(request('paseo').route), { outcome: 'not-capable', diagnostic: 'daemon down' });
});

test('a cancelled send without a verified revalidation stays unknown', async () => {
  const gated = adapter('paseo', {
    async dispatch(_address, _payload, beforeSend) {
      return (await beforeSend()) ? { outcome: 'accepted' } : { outcome: 'cancelled' };
    },
  });
  const transport = createWakeTransport([gated], hostLedger, clock, {});
  assert.deepEqual(await transport.attempt(request('paseo'), 100, async () => false), { outcome: 'unknown', diagnostic: 'wake dispatch cancelled' });
});
