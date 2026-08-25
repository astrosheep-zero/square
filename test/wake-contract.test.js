import assert from 'node:assert/strict';
import test from 'node:test';

import { WAKE_ROUTE_KINDS } from '../dist/model.js';
import { WakePort } from '../dist/wake-port.js';

function route(kind, address = { endpoint: 'endpoint' }) {
  return { ownerId: 'owner', sessionId: `${kind}-session`, kind, address, updatedAt: 1 };
}

/** A scripted adapter that honors the beforeSend gate, then plays outcomes in order. */
function scriptedAdapter(kind, script, calls) {
  return {
    kind,
    async dispatch(address, payload, beforeSend) {
      if (!(await beforeSend())) return { outcome: 'cancelled' };
      calls.push({ address, payload });
      return script.shift();
    },
  };
}

// The same contract matrix runs for every required route kind: the port's
// outcome semantics must be kind-independent, not a per-kind scenario maze.
for (const kind of WAKE_ROUTE_KINDS) {
  test(`wake adapter contract is kind-independent: ${kind}`, async () => {
    // accepted stops global fall-through and records once
    {
      const calls = [];
      const records = [];
      const adapter = scriptedAdapter(kind, [{ outcome: 'accepted' }, { outcome: 'accepted' }], calls);
      const port = new WakePort([adapter]);
      const result = await port.dispatch([route(kind), route(kind)], 'wake', {
        nextAttemptN: () => 1,
        beforeSend: async () => true,
        record: async (r, n, res) => records.push({ kind: r.kind, attemptN: n, outcome: res.outcome }),
      });
      assert.deepEqual(result, { outcome: 'accepted' });
      assert.equal(calls.length, 1);
      assert.deepEqual(records, [{ kind, attemptN: 1, outcome: 'accepted' }]);
    }

    // unknown stops global fall-through and records once
    {
      const calls = [];
      const records = [];
      const adapter = scriptedAdapter(kind, [{ outcome: 'unknown', signature: 's', message: 'm' }, { outcome: 'accepted' }], calls);
      const port = new WakePort([adapter]);
      const result = await port.dispatch([route(kind), route(kind)], 'wake', {
        nextAttemptN: () => 1,
        beforeSend: async () => true,
        record: async (r, n, res) => records.push({ kind: r.kind, attemptN: n, outcome: res.outcome }),
      });
      assert.deepEqual(result, { outcome: 'unknown' });
      assert.equal(calls.length, 1);
      assert.deepEqual(records, [{ kind, attemptN: 1, outcome: 'unknown' }]);
    }

    // failed falls through to the next route and records each attempt
    {
      const calls = [];
      const records = [];
      const adapter = scriptedAdapter(kind, [{ outcome: 'failed', signature: 's', message: 'm' }, { outcome: 'accepted' }], calls);
      const port = new WakePort([adapter]);
      const result = await port.dispatch([route(kind), route(kind)], 'wake', {
        nextAttemptN: () => 1,
        beforeSend: async () => true,
        record: async (r, n, res) => records.push({ kind: r.kind, attemptN: n, outcome: res.outcome }),
      });
      assert.deepEqual(result, { outcome: 'accepted' });
      assert.equal(calls.length, 2);
      assert.deepEqual(records, [
        { kind, attemptN: 1, outcome: 'failed' },
        { kind, attemptN: 1, outcome: 'accepted' },
      ]);
    }

    // beforeSend cancels: nothing is sent, nothing is recorded, and no further adapter is called
    {
      const calls = [];
      const records = [];
      const adapter = scriptedAdapter(kind, [{ outcome: 'accepted' }, { outcome: 'accepted' }], calls);
      const port = new WakePort([adapter]);
      const result = await port.dispatch([route(kind), route(kind)], 'wake', {
        nextAttemptN: () => 1,
        beforeSend: async () => false,
        record: async (r, n, res) => records.push({ kind: r.kind, attemptN: n, outcome: res.outcome }),
      });
      assert.deepEqual(result, { outcome: 'cancelled' });
      assert.equal(calls.length, 0);
      assert.deepEqual(records, []);
    }
  });
}

test('wake port skips route kinds without an adapter and keeps walking', async () => {
  const calls = [];
  const adapter = scriptedAdapter('paseo', [{ outcome: 'accepted' }], calls);
  const port = new WakePort([adapter]);
  const result = await port.dispatch([route('claude-native'), route('paseo')], 'wake', {
    nextAttemptN: () => 1,
    beforeSend: async () => true,
    record: async () => undefined,
  });
  assert.deepEqual(result, { outcome: 'accepted' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address.endpoint, 'endpoint');
});

test('wake port falls through across kinds only after a provable failed', async () => {
  const firstCalls = [];
  const secondCalls = [];
  const port = new WakePort([
    scriptedAdapter('opencode-server', [{ outcome: 'failed', signature: 's', message: 'm' }], firstCalls),
    scriptedAdapter('codex-app-server', [{ outcome: 'accepted' }], secondCalls),
  ]);
  const result = await port.dispatch([route('opencode-server'), route('codex-app-server')], 'wake', {
    nextAttemptN: () => 1,
    beforeSend: async () => true,
    record: async () => undefined,
  });
  assert.deepEqual(result, { outcome: 'accepted' });
  assert.equal(firstCalls.length, 1);
  assert.equal(secondCalls.length, 1);
});

test('wake port retires an unavailable route without recording an attempt', async () => {
  const routeValue = route('paseo');
  const records = [];
  const invalidated = [];
  const port = new WakePort([{
    kind: 'paseo',
    async dispatch() {
      return { outcome: 'unavailable', signature: 'address_not_found', message: 'gone' };
    },
  }]);
  const result = await port.dispatch([routeValue], 'wake', {
    nextAttemptN: () => 1,
    beforeSend: async () => true,
    record: async (_route, _attemptN, value) => records.push(value),
    invalidate: async (value) => invalidated.push(value),
  });
  assert.deepEqual(result, { outcome: 'exhausted' });
  assert.deepEqual(records, []);
  assert.deepEqual(invalidated, [routeValue]);
});

test('wake port retains an unavailable route when the adapter asks for retry', async () => {
  const routeValue = route('paseo');
  const invalidated = [];
  const port = new WakePort([{
    kind: 'paseo',
    async dispatch() {
      return { outcome: 'unavailable', signature: 'discovery_transient', message: 'daemon down', retainRoute: true };
    },
  }]);
  await port.dispatch([routeValue], 'wake', {
    nextAttemptN: () => 1,
    beforeSend: async () => true,
    record: async () => undefined,
    invalidate: async (value) => invalidated.push(value),
  });
  assert.deepEqual(invalidated, []);
});
