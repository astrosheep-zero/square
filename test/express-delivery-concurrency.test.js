import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Square } from '../dist/square-api.js';
import { PaseoWakeTransport } from '../dist/paseo-delivery.js';

async function fixture(t, transport, receivers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'express-concurrency-'));
  const base = { path: path.join(dir, 'test.square'), env: { ...process.env, SQUARE_INDEX: path.join(dir, 'index') }, wakeTransport: transport };
  const root = await Square.build({ ...base, markdown: '' });
  const alice = (await root.join('Alice', { body: { channel: 'test', session: 'sender' } })).participant;
  const resources = [root];
  t.after(async () => { await Promise.all(resources.map(r => r.close())); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const [i, receiver] of receivers.entries()) {
    const identity = typeof receiver === 'string' ? { session: receiver } : receiver;
    const resource = await Square.at(base);
    resources.push(resource);
    await resource.join(`R${i}`, { body: { channel: 'test', ...identity }, wakeAddress: { kind: 'paseo', address: { agentId: identity.session } } });
  }
  return { alice, names: receivers.map((_, i) => `R${i}`) };
}

test('express overlaps four receiver identities, keeps same-Body order, and drains before returning', { timeout: 5000 }, async t => {
  const starts = [], activeReceivers = new Set();
  let active = 0, peak = 0, release, firstWave;
  const gate = new Promise(r => { release = r; });
  const wave = new Promise(r => { firstWave = r; });
  const transport = { async attempt(request, _budget, beforeSend) {
    const receiver = JSON.stringify(request.seat.body);
    assert.equal(activeReceivers.has(receiver), false, 'same-Body notifications must not overlap');
    activeReceivers.add(receiver); starts.push(request.participant); peak = Math.max(peak, ++active);
    if (active === 4) firstWave();
    await gate;
    assert.equal(await beforeSend(), true);
    activeReceivers.delete(receiver); active--;
    return { outcome: 'accepted' };
  } };
  const { alice, names } = await fixture(t, transport, ['shared', 'shared', { session: 'shared', agent: 'child-a' },
    { session: 'shared', agent: 'child-b' }, 'b', 'c']);
  let returned = false;
  const sending = alice.express('hello', { mentions: names, force: true }).then(result => { returned = true; return result; });
  try {
    await Promise.race([wave, sleep(2000, undefined, { ref: false }).then(() => { throw new Error('first wave remained serial'); })]);
    assert.equal(returned, false);
    assert.equal(starts.includes('R1'), false, 'second name in the same Body is still waiting');
    assert.ok(starts.includes('R2') && starts.includes('R3'), 'different agent identities sharing a session can dispatch independently');
  } finally { release(); }
  const result = await sending;
  assert.equal(result.activity.body, 'hello');
  assert.equal(starts.length, 6);
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.ok(starts.indexOf('R0') < starts.indexOf('R1'));
});

test('concurrent Paseo wakes share only an in-flight discovery, and a later send refreshes status', { timeout: 5000 }, async t => {
  let reads = 0, sends = 0, release, entered;
  let status = 'idle';
  const gate = new Promise(r => { release = r; });
  const allEntered = new Promise(r => { entered = r; });
  const transport = new PaseoWakeTransport({
    discover: async () => { reads++; await gate; return { agents: ['a', 'b', 'c'].map(id => ({ id, status })) }; },
    sendWake: async () => { sends++; },
  });
  // Observe entry into the coalescer without timing assumptions about SQLite reads.
  const discover = transport.discover.bind(transport);
  let callers = 0;
  transport.discover = budget => { const result = discover(budget); if (++callers === 3) entered(); return result; };
  const { alice, names } = await fixture(t, transport, ['a', 'b', 'c']);
  const sending = alice.express('first', { mentions: names, force: true });
  try {
    await Promise.race([allEntered, sleep(2000, undefined, { ref: false }).then(() => { throw new Error('discoveries did not overlap'); })]);
    assert.equal(reads, 1);
  } finally { release(); }
  assert.equal((await sending).activity.body, 'first');
  assert.equal(sends, 3);
  status = 'running';
  const later = await alice.express('later', { mentions: ['R0'], force: true });
  assert.equal(reads, 2);
  assert.equal(later.activity.body, 'later');
  assert.equal(sends, 3, 'old idle status was not cached');
});
