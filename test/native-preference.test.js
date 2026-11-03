import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { sessionInbox } from '../dist/inbox.js';

test('a registered route owns Pi delivery, including when registered after inbox projection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-route-'));
  const location = path.join(root, 'route.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const square = await Square.build({ path: location, markdown: 'Routes', env, wakeTransport: false });
  const artifact = createArtifactPort(location);
  t.after(async () => { await artifact.close(); await square.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = 'pi:route-test';
  const address = { kind: 'paseo', address: { agentId: 'receiver' } };
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const routed = [
    ['Paseo', address],
    ['Http', { kind: 'http', address: { url: 'https://example.com/wake' } }],
    ['RegisteredNative', { kind: 'codex-queue', address: { sessionId: 'receiver' } }],
  ];
  for (const [name, wakeAddress] of routed) await square.join(name, { owner, wakeAddress });
  await square.join('Native', { owner });
  await square.join('Racing', { owner });
  const activity = (await alice.express({ body: 'hello everyone', mentions: [...routed.map(([name]) => name), 'Native', 'Racing'], force: true })).activity;
  const index = (await artifact.read(facts => facts.activity(Number(activity.id.slice(4))).messageIndex)).value;
  const seat = name => artifact.read(facts => facts.seat(name)).then(result => result.value);
  const state = async name => {
    const captured = await seat(name);
    return (await artifact.read(facts => ({ receipt: facts.channel.receipt(name, index),
      evidence: facts.channel.deliveryEvidence(name, captured.generation, `msg/${index}`) }))).value;
  };
  const batch = await sessionInbox(owner, env);
  const native = batch.find(item => item.seat.participant === 'Native').notifications[0];
  const body = native.body;
  let registration;
  // Rendering follows the boundary's inbox projection but precedes its item claims.
  Object.defineProperty(native, 'body', { get() {
    registration ??= square.join('Racing', { owner, wakeAddress: address });
    return body;
  } });
  let calls = 0;
  const text = await presentPendingAtBoundary(owner, context => { calls++; return context; }, () => batch, env);
  assert.ok(registration);
  await registration;
  assert.deepEqual((await seat('Racing')).wakeAddress, address);
  assert.equal(calls, 1);
  assert.match(text, /hello everyone/);
  assert.ok((await state('Native')).receipt, 'address-free Pi presentation records its receipt');
  for (const name of [...routed.map(([name]) => name), 'Racing']) {
    const result = await state(name);
    assert.equal(result.receipt, undefined, `${name} remains pending`);
    assert.equal(result.evidence.some(row => row.outcome === 'presented' || row.outcome === 'clipped'), false);
  }
});

// Native registrations belong to a seat generation, not an expiring routes table.
// Ordinary managed reconnects must preserve them; retirement and takeover must not.
test('managed reconnect preserves receiver-native custody until retirement or a new seat generation', async t => {
  for (const kind of ['claude-native', 'opencode-server']) {
    await t.test(kind, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-native-preference-'));
      const location = path.join(root, 'native.square');
      const body = `${kind === 'claude-native' ? 'claude-code' : 'opencode'}:managed`;
      const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
      const fallback = { kind: 'paseo', address: { agentId: 'managed-agent' } };
      const native = { kind, address: { sessionId: 'managed', ...(kind === 'claude-native' ? { endpoint: '/tmp/receiver.sock', loaded: 'true' } : {}) } };
      const initial = await Square.build({ path: location, markdown: 'Native custody', env });
      await initial.join('Bob', { owner: body, wakeAddress: fallback });
      await initial.close();
      const artifact = createArtifactPort(location);
      t.after(async () => { await artifact.close(); fs.rmSync(root, { recursive: true, force: true }); });
      const seat = async () => (await artifact.read(facts => facts.seat('Bob'))).value;
      const open = () => Square.at({ path: location, env });
      const receiver = await open();
      try { assert.equal((await receiver.join('Bob', { owner: body, wakeAddress: native })).kind, 'reconnected'); }
      finally { await receiver.close(); }
      const registered = await seat();
      assert.deepEqual(registered.wakeAddress, native);
      const managed = await open();
      try {
        assert.equal((await managed.join('Bob', { owner: body, wakeAddress: fallback })).kind, 'reconnected');
        assert.deepEqual(await seat(), registered);
        assert.equal((await managed.reattach('Bob', { owner: body, wakeAddress: fallback })).name, 'Bob');
        assert.deepEqual(await seat(), registered);
        await (await managed.participant('Bob', { owner: body })).express('*waves*', { force: true });
        assert.deepEqual(await seat(), registered, 'express does not publish a generic replacement address');

        // An explicit receiver withdrawal permits fallback without inventing expiry policy.
        await artifact.transactAs({ kind: 'participant', seat: registered }, facts => facts.updateWakeAddress(registered, undefined));
        await managed.join('Bob', { owner: body, wakeAddress: fallback });
        assert.deepEqual((await seat()).wakeAddress, fallback);
        const restored = await open();
        try { await restored.join('Bob', { owner: body, wakeAddress: native }); } finally { await restored.close(); }
        assert.deepEqual((await seat()).wakeAddress, native);

        await managed.join('Bob', { owner: body, wakeAddress: fallback, takeover: true });
        const replacement = await seat();
        assert.notEqual(replacement.generation, registered.generation);
        assert.deepEqual(replacement.wakeAddress, fallback, 'new generation cannot inherit the old native registration');
      } finally { await managed.close(); }
    });
  }
});
