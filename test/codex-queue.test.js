import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCodexBoundary,
  codexQueueEligible,
  readCodexBoundary,
  recordCodexBoundary,
} from '../dist/codex-boundary-state.js';
import {
  CodexQueueTransport,
  CodexQueueSendError,
  sendCodexQueue,
} from '../dist/codex-queue.js';
import { createArtifactPort } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { createDefaultWakeTransport } from '../dist/notifications.js';
import { squareClock } from '../dist/square-api.js';
import { nodeCommandFixture } from './node-command-fixture.js';

async function pending(t, env) {
  const artifact = createArtifactPort(':memory:', { hardCap: null, preamble: [], warmup: [], acts: [], runtime: emptyRuntimeState() });
  t.after(() => artifact.close());
  const join = async (name, wakeAddress) => (await artifact.transactAs({ kind: 'join', participant: name,
    body: { channel: 'test', session: name }, wakeAddress }, facts => {
    facts.land({ kind: 'join', actor: name, at: 1 });
    return facts.seat(name);
  })).value;
  const alice = await join('Alice');
  const bob = await join('Bob', { kind: 'codex-queue', address: { threadId: 'thread-a' } });
  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 2, body: 'stored awareness', mentions: ['Bob'] }));
  return { artifact, bob, location: '/tmp/codex-test.square', activity: 'act/2',
    transport: new CodexQueueTransport({ env }) };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-queue-'));
  return { root, env: { SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json') } };
}

test('Codex boundary state allows queue only after the latest Stop', async () => {
  const item = fixture();
  try {
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    await recordCodexBoundary('thread-a', 'non-stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    assert.deepEqual(await readCodexBoundary('thread-a', item.env), { lastStop: 3, lastNonStop: 2 });
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex boundary state is isolated per thread and SessionEnd clears it', async () => {
  const item = fixture();
  try {
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    await recordCodexBoundary('thread-b', 'non-stop', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    assert.equal(await codexQueueEligible('thread-b', item.env), false);
    await clearCodexBoundary('thread-a', item.env);
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    assert.equal(await readCodexBoundary('thread-a', item.env), undefined);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex queue transport retains an ineligible route without sending', async (t) => {
  const item = fixture();
  let sent = false;
  try {
    const input = await pending(t, item.env);
    const result = await new CodexQueueTransport({
      env: item.env,
      sendQueue: () => { sent = true; },
    }).attempt({ ...input, participant: 'Bob', seat: input.bob,
      route: { kind: 'codex-queue', address: { threadId: 'thread-a' } } }, 5000, async () => assert.fail('readiness must precede gate'));
    assert.deepEqual(result, {
      outcome: 'failed',
      unavailable: true,
      signature: 'boundary_not_stopped',
      message: 'The Codex thread has not reached a current Stop boundary.',
      retainRoute: true,
    });
    assert.equal(sent, false);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex queue transport sends stored preview only after the final boundary and artifact gates', async (t) => {
  const item = fixture();
  const requests = [];
  const timeouts = [];
  try {
    await recordCodexBoundary('thread-a', 'Stop', item.env);
    const input = await pending(t, item.env);
    const result = await deliverPending({ ...input, timeoutMs: 321, transport: new CodexQueueTransport({
      env: item.env,
      sendQueue: (request, options) => { requests.push(request); timeouts.push(options.timeoutMs); },
    }) });
    assert.equal(result.accepted, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].threadId, 'thread-a');
    assert.match(requests[0].message, /Alice spoke your name\./);
    assert.match(requests[0].message, /stored awareness/);
    assert.ok(timeouts[0] > 0 && timeouts[0] <= 321);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Codex final gate can suppress after Stop readiness without queueing', async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  const input = await pending(t, item.env);
  let sends = 0, gates = 0;
  const transport = new CodexQueueTransport({ env: item.env, sendQueue: () => { sends += 1; } });
  const result = await transport.attempt({ ...input, participant: 'Bob', seat: input.bob,
    route: { kind: 'codex-queue', address: { threadId: 'thread-a' } } }, 5000, async () => {
    gates += 1;
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    return false;
  });
  assert.deepEqual(result, { outcome: 'not-capable' });
  assert.equal(gates, 1);
  assert.equal(sends, 0);
});

test('Codex rechecks Stop after an asynchronous final artifact gate', async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  const input = await pending(t, item.env);
  let sends = 0;
  const transport = new CodexQueueTransport({ env: item.env, sendQueue: () => { sends += 1; } });
  const result = await transport.attempt({ ...input, participant: 'Bob', seat: input.bob,
    route: { kind: 'codex-queue', address: { threadId: 'thread-a' } } }, 321, async () => {
    await recordCodexBoundary('thread-a', 'non-stop', item.env);
    return true;
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.signature, 'boundary_not_stopped');
  assert.equal(sends, 0);
});

test('frozen entry semantic clock cannot freeze the default Codex I/O deadline', async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  const input = await pending(t, item.env);
  const env = { ...item.env, SQUARE_CODEX_BIN: '/must-not-send', SQUARE_NOW_MS: '100' };
  const semanticClock = squareClock(env);
  const transport = await createDefaultWakeTransport(env);
  let wallNow = 1000;
  t.mock.method(Date, 'now', () => wallNow);
  const result = await transport.attempt({ ...input, participant: 'Bob', seat: input.bob,
    route: { kind: 'codex-queue', address: { threadId: 'thread-a' } } }, 321, async () => {
    await Promise.resolve();
    wallNow += 321;
    assert.equal(semanticClock(), 100);
    return true;
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.signature, 'dispatch_budget_exhausted');
});

test('default Codex transport retains supplied executable and child environment after ambient mutation', async t => {
  const fake = nodeCommandFixture('square-captured-codex', `
    require('node:fs').writeFileSync(process.env.SQUARE_CODEX_ARGS, process.argv.slice(2).join('\\n'));
  `);
  t.after(() => fs.rmSync(fake.root, { recursive: true, force: true }));
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const args = path.join(fake.root, 'args');
  // sendCodexQueue's bin is an executable; the fixture launches its script via its shell entry.
  const bin = path.join(fake.root, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${fake.bin}' '${fake.args[0]}' "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, ...item.env, SQUARE_CODEX_BIN: bin, SQUARE_CODEX_ARGS: args, SQUARE_DISABLE_PASEO_WAKE: '1' };
  await recordCodexBoundary('thread-a', 'Stop', env);
  const input = await pending(t, env);
  const transport = await createDefaultWakeTransport(env);
  const previous = process.env.SQUARE_CODEX_BIN;
  process.env.SQUARE_CODEX_BIN = '/missing/ambient-codex';
  t.after(() => { if (previous === undefined) delete process.env.SQUARE_CODEX_BIN; else process.env.SQUARE_CODEX_BIN = previous; });
  // This is a child-startup allowance, not the asserted send deadline. Mocked-budget
  // and frozen-clock tests above retain 321ms and require exhaustion before sending.
  const result = await deliverPending({ ...input, transport, timeoutMs: 2000 });
  const evidence = (await input.artifact.read(facts => facts.deliveryEvidence('Bob', input.bob.generation))).value;
  assert.equal(result.accepted, 1, JSON.stringify({ result, evidence }));
  const queued = fs.readFileSync(args, 'utf8');
  assert.match(queued, /^queue\n--thread\nthread-a\n--message\n/);
  assert.match(queued, /stored awareness/);
});

test('Codex queue transport uses the exact CLI shape and classifies failures', () => {
  const fake = nodeCommandFixture('square-codex-queue', `
    require('node:fs').writeFileSync(process.env.SQUARE_CODEX_ARGS, process.argv.slice(2).join('\\n'));
  `);
  try {
    const env = { ...process.env, SQUARE_CODEX_ARGS: path.join(fake.root, 'args') };
    sendCodexQueue({ threadId: 'thread-a', message: 'hello' }, { args: fake.args, bin: fake.bin, env });
    assert.deepEqual(fs.readFileSync(env.SQUARE_CODEX_ARGS, 'utf8').trim().split('\n'), [
      'queue', '--thread', 'thread-a', '--message', 'hello',
    ]);
    assert.throws(
      () => sendCodexQueue({ threadId: 'thread-a', message: 'hello' }, { bin: '/missing/codex' }),
      (error) => error instanceof CodexQueueSendError && error.kind === 'transient',
    );
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});
