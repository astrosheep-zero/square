import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';

// Native registrations belong to a seat generation, not an expiring routes table.
// Ordinary managed reconnects must preserve them; retirement and takeover must not.
test('managed reconnect preserves receiver-native custody until retirement or a new seat generation', async t => {
  for (const kind of ['claude-native', 'opencode-server']) {
    await t.test(kind, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-native-preference-'));
      const location = path.join(root, 'native.square');
      const body = { channel: kind === 'claude-native' ? 'claude-code' : 'opencode', session: 'managed' };
      const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
      const fallback = { kind: 'paseo', address: { agentId: 'managed-agent' } };
      const native = { kind, address: { sessionId: body.session, ...(kind === 'claude-native' ? { endpoint: '/tmp/receiver.sock', loaded: 'true' } : {}) } };
      const initial = await Square.build({ path: location, markdown: 'Native custody', env });
      await initial.join('Bob', { body, wakeAddress: fallback });
      await initial.close();
      const artifact = createArtifactPort(location);
      t.after(async () => { await artifact.close(); fs.rmSync(root, { recursive: true, force: true }); });
      const seat = async () => (await artifact.read(facts => facts.seat('Bob'))).value;
      const open = () => Square.at({ path: location, env });
      const receiver = await open();
      try { assert.equal((await receiver.join('Bob', { body, wakeAddress: native })).kind, 'reconnected'); }
      finally { await receiver.close(); }
      const registered = await seat();
      assert.deepEqual(registered.wakeAddress, native);
      const managed = await open();
      try {
        assert.equal((await managed.join('Bob', { body, wakeAddress: fallback })).kind, 'reconnected');
        assert.deepEqual(await seat(), registered);
        assert.equal((await managed.reattach('Bob', { body, wakeAddress: fallback })).name, 'Bob');
        assert.deepEqual(await seat(), registered);
        await (await managed.participant('Bob', { body })).express('*waves*', { force: true });
        assert.deepEqual(await seat(), registered, 'express does not publish a generic replacement address');

        // An explicit receiver withdrawal permits fallback without inventing expiry policy.
        await artifact.transactAs({ kind: 'participant', seat: registered }, facts => facts.updateWakeAddress(registered, undefined));
        await managed.join('Bob', { body, wakeAddress: fallback });
        assert.deepEqual((await seat()).wakeAddress, fallback);
        const restored = await open();
        try { await restored.join('Bob', { body, wakeAddress: native }); } finally { await restored.close(); }
        assert.deepEqual((await seat()).wakeAddress, native);

        await managed.join('Bob', { body, wakeAddress: fallback, takeover: true });
        const replacement = await seat();
        assert.notEqual(replacement.generation, registered.generation);
        assert.deepEqual(replacement.wakeAddress, fallback, 'new generation cannot inherit the old native registration');
      } finally { await managed.close(); }
    });
  }
});
