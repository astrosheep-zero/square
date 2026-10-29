import assert from 'node:assert/strict';
import test from 'node:test';
import { createWakeTransport, createDefaultWakeTransport } from '../dist/notifications.js';

const request = (kind) => ({
  location: '/tmp/transport.square', participant: 'Faye', activity: 'act/2', actor: 'Bev',
  seat: { participant: 'Faye', generation: 'act/1', body: { channel: 'test', session: 'faye' } },
  route: { kind, address: {}, location: '/tmp/transport.square', participant: 'Faye', updatedAt: 1 },
});
const gate = async () => true;

test('every route receives the identical full request, deadline budget and supplied gate', async () => {
  for (const kind of ['paseo', 'codex-queue', 'claude-native', 'opencode-server']) {
    const captured = request(kind);
    const transport = createWakeTransport({ [kind]: {
      async probe(route) { assert.equal(route, captured.route); return true; },
      async attempt(actual, timeoutMs, beforeSend) {
        assert.equal(actual, captured);
        assert.equal(timeoutMs, 100);
        assert.equal(beforeSend, gate);
        assert.equal(await beforeSend(), true);
        return { outcome: 'unknown', signature: 'native_admission_unconfirmed' };
      },
    } });
    assert.equal(await transport.probe(captured.route), true);
    assert.deepEqual(await transport.attempt(captured, 100, gate), { outcome: 'unknown', signature: 'native_admission_unconfirmed' });
  }
});

test('missing route is not-capable without a gate call or evidence access', async () => {
  const transport = createWakeTransport({});
  const expected = { outcome: 'not-capable', diagnostic: 'no transport for codex-queue' };
  assert.deepEqual(await transport.probe(request('codex-queue').route), expected);
  assert.deepEqual(await transport.attempt(request('codex-queue'), 100, async () => assert.fail('no send')), expected);
});

test('probe uses the same typed route interface and never attempts a send', async () => {
  const captured = request('paseo');
  const transport = createWakeTransport({ paseo: {
    async probe(route) { assert.equal(route, captured.route); return false; },
    async attempt() { assert.fail('probe cannot send'); },
  } });
  assert.equal(await transport.probe(captured.route), false);
  const implicit = createWakeTransport({ paseo: { async attempt() { assert.fail('probe cannot send'); } } });
  assert.equal(await implicit.probe(captured.route), true);
  const failing = createWakeTransport({ paseo: {
    async probe() { throw new Error('daemon down'); }, async attempt() { assert.fail('probe cannot send'); },
  } });
  assert.deepEqual(await failing.probe(captured.route), { outcome: 'not-capable', diagnostic: 'daemon down' });
});

test('route selection preserves accepted, failed, unknown and suppressed outcomes without translation', async () => {
  for (const outcome of [
    { outcome: 'accepted' },
    { outcome: 'failed', signature: 'agent_not_idle' },
    { outcome: 'failed', signature: 'invalid_address' },
    { outcome: 'unknown', signature: 'send_unknown' },
    { outcome: 'not-capable' },
  ]) {
    const transport = createWakeTransport({ paseo: { async attempt(_request, _timeout, beforeSend) {
      assert.equal(await beforeSend(), false);
      return outcome;
    } } });
    assert.equal(await transport.attempt(request('paseo'), 100, async () => false), outcome);
  }
});

test('default transport injection is the same complete route map, not a native side channel', async () => {
  const supplied = { async attempt(actual, timeoutMs, beforeSend) {
    assert.equal(actual.route.kind, 'opencode-server');
    assert.equal(timeoutMs, 23);
    assert.equal(beforeSend, gate);
    return { outcome: 'accepted' };
  } };
  const transport = await createDefaultWakeTransport({}, { 'opencode-server': supplied });
  assert.deepEqual(await transport.attempt(request('opencode-server'), 23, gate), { outcome: 'accepted' });
  assert.equal((await transport.probe(request('claude-native').route)).outcome, 'not-capable');
});
