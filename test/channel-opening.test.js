import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { channelStoreFormat } from '../dist/channel-sqlite-schema.js';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A standalone channel must never need the Agora artifact or domain to load or operate.
const upperLoads = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (/\/(?:artifact|square-sqlite|square-domain|square-core|attention|attention-presentation|decisions|inbox|wake-preview)\.js(?:\?|$)/.test(result.url)) {
      upperLoads.push(result.url);
      throw new Error(`Unexpected Agora dependency: ${result.url}`);
    }
    return result;
  },
});
const { Channel } = await import('../dist/channel.js');

async function exchange(channel, text) {
  const recipient = await channel.attach('Recipient', { owner: 'test:recipient' });
  const sent = await channel.send({ from: 'Sender', to: 'Recipient', body: text });
  const pending = await recipient.pending();
  assert.equal(pending.messages.length, 1);
  assert.equal(pending.messages[0].id, sent.id);
  assert.equal(pending.messages[0].body, text);
  const received = await recipient.receive();
  assert.equal(received.messages[0].body, text);
  assert.equal((await recipient.pending()).messages.length, 0);
}

test('standalone file and memory channels open and exchange messages without Agora setup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-opening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index') };
  const input = { path: 'standalone.square', cwd: root, env, wakeTransport: false, description: '# Direct\n' };
  const created = await Channel.create(input);
  try { await exchange(created, 'file message'); } finally { await created.close(); }
  await assert.rejects(Channel.create(input));
  const opened = await Channel.open(input);
  try {
    assert.equal((await opened.history({ limit: null })).messages[0].body, 'file message');
    assert.equal((await opened.history()).messages.length, 1);
  } finally { await opened.close(); }
  const replaced = await Channel.create({ ...input, force: true });
  try { assert.equal((await replaced.history({ limit: null })).messages.length, 0); }
  finally { await replaced.close(); }
  const memory = Channel.inMemory({ env, wakeTransport: false, description: '# Memory\n' });
  assert.equal(typeof memory.then, 'undefined', 'inMemory remains a synchronous factory');
  try {
    await exchange(memory, 'memory message');
  } finally { await memory.close(); }
  const defaults = await Channel.create({ path: path.join(root, 'defaults.square'), env });
  await defaults.close();
  const defaultOpen = await Channel.open({ path: path.join(root, 'defaults.square'), env });
  try { await exchange(defaultOpen, 'default transport message'); } finally { await defaultOpen.close(); }
  assert.deepEqual(upperLoads, [], 'optional transport imports must not silently swallow an Agora dependency');
});

test('Channel open and explicit replacement refuse an unsupported format without changing its bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, 'legacy.square'), db = new DatabaseSync(location);
  try {
    db.exec(`CREATE TABLE unknown_format (id INTEGER PRIMARY KEY); PRAGMA application_id=${channelStoreFormat.applicationId}; PRAGMA user_version=999`);
  } finally { db.close(); }
  const bytes = fs.readFileSync(location);
  for (const open of [() => Channel.open({ path: location, wakeTransport: false }),
    () => Channel.create({ path: location, force: true, wakeTransport: false })]) {
    await assert.rejects(open(), /unsupported Channel SQLite format version/);
    assert.deepEqual(fs.readFileSync(location), bytes);
  }
});

test('memory channel delivers only after the message commits', async () => {
  let recipient;
  const seen = [];
  const channel = Channel.inMemory({ wakeTransport: {
    async attempt(_request, _timeout, beforeSend) {
      assert.equal(await beforeSend(), true);
      seen.push((await recipient.pending()).messages.map(message => message.body));
      return { outcome: 'accepted' };
    },
  } });
  try {
    recipient = await channel.attach('Recipient', { owner: 'test:recipient',
      wakeAddress: { kind: 'paseo', address: { agentId: 'recipient' } } });
    await channel.send({ from: 'Sender', to: 'Recipient', body: 'committed' });
    assert.deepEqual(seen, [['committed']]);
  } finally { await channel.close(); }
});
