import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { streamSquare } from '../dist/stream.js';
import { processActNotificationsOnce, sweepPendingNotifications } from '../dist/notifications.js';
import { classifyDeliveryHealth, doctorDeliveryHealth } from '../dist/delivery-health.js';
import { runClaudeMod } from '../dist/claude-mod.js';

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-stream-resource-')));
  const env = { SQUARE_INDEX: path.join(root, 'index.ndjsonl'), SQUARE_DISABLE_PASEO_WAKE: '1' };
  const body = "claude-code" + ":" + ('stream-resource');
  const location = path.join(root, 'original.square');
  const square = await Square.build({ path: location, markdown: '', env });
  t.after(async () => { await square.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: body })).participant;
  await alice.express('original');
  return { root, env, body, location, square, alice };
}

test('public path stream follows atomic replacement independently of the open resource inode', async t => {
  const f = await fixture(t), replacementPath = path.join(f.root, 'replacement.square');
  const controller = new AbortController();
  const iterator = f.square.stream({ start: { kind: 'tail', last: 1 } }, { signal: controller.signal })[Symbol.asyncIterator]();
  t.after(() => iterator.return());
  assert.equal((await iterator.next()).value.body, 'original');
  const pending = iterator.next();
  const replacement = await Square.build({ path: replacementPath, markdown: '', env: f.env });
  try {
    const alice = (await replacement.join('Alice', { owner: f.body })).participant;
    await alice.express('same coordinate');
    await alice.express('after replacement');
  } finally { await replacement.close(); }
  fs.renameSync(replacementPath, f.location);
  const timer = setTimeout(() => controller.abort(new Error('stream stranded after replacement')), 2000);
  try { assert.equal((await pending).value.body, 'after replacement'); }
  finally { clearTimeout(timer); }
  assert.equal((await f.square.history()).activities.at(-1).body, 'original', 'resource still owns its original connection; the path stream follows the path');
});

test('closing the resource does not strand its path stream; iterator disposal releases an outstanding pull', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const iterator = f.square.stream({ start: { kind: 'tail', last: 1 } }, { signal: controller.signal })[Symbol.asyncIterator]();
  t.after(() => iterator.return());
  assert.equal((await iterator.next()).value.body, 'original');
  await f.square.close();
  const pending = iterator.next();
  const writer = await Square.at({ path: f.location, env: f.env });
  try { await (await writer.participant('Alice', { owner: f.body })).express('after owner close'); }
  finally { await writer.close(); }
  const timer = setTimeout(() => controller.abort(new Error('closed owner stranded path stream')), 2000);
  try { assert.equal((await pending).value.body, 'after owner close'); }
  finally { clearTimeout(timer); }
  const waiting = iterator.next();
  const disposalTimer = setTimeout(() => controller.abort(new Error('iterator disposal did not release pull')), 1000);
  try {
    assert.deepEqual(await iterator.return(), { done: true, value: undefined });
    assert.deepEqual(await waiting, { done: true, value: undefined });
  } finally { clearTimeout(disposalTimer); }
});

test('explicit borrowed stream leaves its port alive and reports a closed port instead of waiting for path repair', async t => {
  const f = await fixture(t), artifact = createArtifactPort(f.location);
  t.after(() => artifact.close());
  const iterator = streamSquare(f.location, { start: { kind: 'tail', last: 1 } }, undefined, artifact)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.body, 'original');
  await iterator.return();
  assert.ok((await artifact.read(facts => facts.header())).value.nextActIndex > 0);
  await artifact.close();
  const controller = new AbortController();
  const closed = streamSquare(f.location, {}, { signal: controller.signal }, artifact)[Symbol.asyncIterator]();
  const timer = setTimeout(() => controller.abort(new Error('closed port was swallowed')), 1000);
  try { await assert.rejects(closed.next(), /Square artifact is closed/); }
  finally { clearTimeout(timer); await closed.return(); }
});

test('direct diagnostics preserve unavailable errors while host resume skips missing candidate paths', async t => {
  const f = await fixture(t);
  await f.alice.done();
  await f.square.close();
  fs.unlinkSync(f.location);
  for (const operation of [
    () => processActNotificationsOnce(f.location, 0, { env: f.env, transports: {} }),
    () => sweepPendingNotifications(f.location, { env: { ...f.env, SQUARE_DISABLE_PASEO_WAKE: '0' } }),
    () => classifyDeliveryHealth(f.location, { graceMs: 0 }),
    () => doctorDeliveryHealth(f.location, 0, Date.now(), f.env),
  ]) await assert.rejects(operation, error => error.code === 'unavailable' && error.message === `Square is unavailable at ${f.location}`);
  const resumed = JSON.parse(await runClaudeMod(JSON.stringify({ operation: 'start', resume: true,
    sessionId: 'stream-resource', cwd: f.root, version: 'test' }), f.env));
  assert.deepEqual(resumed.bindings, []);
});
