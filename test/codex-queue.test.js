import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearCodexBoundary, codexQueueEligible, readCodexBoundary, recordCodexBoundary } from '../dist/codex-boundary-state.js';
import { CodexQueueTransport, CodexQueueSendError, sendCodexQueue } from '../dist/codex-queue.js';
import { codexHookResponse } from '../dist/codex-hook.js';
import { connect, DeliveryError } from '../dist/packages/agent-delivery/src/index.js';
import { createArtifactPort } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { createDefaultWakeTransport } from '../dist/notifications.js';
import { squareClock } from '../dist/square-api.js';
import { nodeCommandFixture } from './node-command-fixture.js';

async function pending(t, env, address = { threadId: 'thread-a' }) {
  const artifact = createArtifactPort(':memory:', { hardCap: null, preamble: [], warmup: [], acts: [], runtime: emptyRuntimeState() });
  t.after(() => artifact.close());
  const join = async (name, wakeAddress) => (await artifact.transactAs({ kind: 'join', participant: name,
    owner: `test:${name}`, wakeAddress }, facts => {
    facts.land({ kind: 'join', actor: name, at: 1 });
    return facts.seat(name);
  })).value;
  const alice = await join('Alice');
  const bob = await join('Bob', { kind: 'codex-queue', address });
  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 2, body: 'stored awareness', mentions: ['Bob'] }));
  return { artifact, bob, location: '/tmp/codex-test.square', activity: 'act/2',
    participant: 'Bob', seat: bob, route: { kind: 'codex-queue', address }, transport: new CodexQueueTransport({ env }) };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capture = path.join(root, 'sent.json'), script = path.join(root, 'queue.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME}));`);
  return { root, capture, env: { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl'),
    SQUARE_DISABLE_PASEO_WAKE: '1', CODEX_HOME: '/sender/codex', SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json') },
    connect: (options) => connect({ ...options, bin: process.execPath, args: [script] }) };
}

test('Codex boundary state allows queue only after the latest Stop and stays thread-local', async t => {
  const item = fixture(t);
  assert.equal(await codexQueueEligible('thread-a', item.env), false);
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  assert.equal(await codexQueueEligible('thread-a', item.env), true);
  await recordCodexBoundary('thread-a', 'non-stop', item.env);
  assert.equal(await codexQueueEligible('thread-a', item.env), false);
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  assert.deepEqual(await readCodexBoundary('thread-a', item.env), { lastStop: 3, lastNonStop: 2 });
  await recordCodexBoundary('thread-b', 'non-stop', item.env);
  assert.equal(await codexQueueEligible('thread-a', item.env), true);
  assert.equal(await codexQueueEligible('thread-b', item.env), false);
  await clearCodexBoundary('thread-a', item.env);
  assert.equal(await readCodexBoundary('thread-a', item.env), undefined);
});

test('Codex queue transport retains an ineligible route without sending', async t => {
  const item = fixture(t), input = await pending(t, item.env);
  const result = await new CodexQueueTransport({ env: item.env, connect: item.connect }).attempt(input, 5000, async () => true);
  assert.deepEqual(result, { outcome: 'failed', signature: 'boundary_not_stopped',
    message: 'The Codex thread has no current Stop boundary for queueing.' });
  assert.equal(fs.existsSync(item.capture), false);
});

test('artifact-owned dispatch sends its stored preview through public connect and one bound lifecycle check', async t => {
  const item = fixture(t);
  const address = { threadId: 'thread-a', codexHome: '/recipient/codex', endpoint: 'unix:///recipient/control.sock' };
  const input = await pending(t, item.env, address);
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  let boundaryReads = 0, timeout;
  const transport = new CodexQueueTransport({ env: item.env, connect: async options => {
    assert.equal(options.harness, 'codex');
    assert.equal(options.transport, 'cli');
    assert.equal(options.codexHome, address.codexHome);
    assert.equal(options.endpoint, address.endpoint);
    const agent = await item.connect({ ...options, boundaries: {
      queueEligible: async id => { boundaryReads++; return options.boundaries.queueEligible(id); },
    } });
    return { ...agent, queue: (text, control) => { timeout = control.timeoutMs; return agent.queue(text, control); } };
  } });
  await deliverPending({ ...input, transport, timeoutMs: 2000 });
  assert.equal(boundaryReads, 1, 'the bound client alone checks lifecycle at queue time');
  const sent = JSON.parse(fs.readFileSync(item.capture, 'utf8'));
  assert.equal(sent.home, '/recipient/codex');
  assert.deepEqual(sent.args.slice(0, 6), ['queue', '--remote', address.endpoint, '--thread', 'thread-a', '--message']);
  assert.match(sent.args[6], /Alice spoke your name\./);
  assert.match(sent.args[6], /stored awareness/);
  assert.ok(timeout > 0 && timeout <= 2000);
  assert.equal(item.env.CODEX_HOME, '/sender/codex');
  const evidence = (await input.artifact.read(facts => facts.deliveryEvidence('Bob', input.bob.generation))).value;
  assert.equal(evidence.find(row => row.kind === 'wake').outcome, 'accepted');
});

test('Codex final artifact gate can suppress without connecting or queueing', async t => {
  const item = fixture(t), input = await pending(t, item.env);
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  const transport = new CodexQueueTransport({ env: item.env, connect: () => assert.fail('must not connect') });
  assert.deepEqual(await transport.attempt(input, 5000, async () => false), { outcome: 'not-capable' });
  assert.equal(fs.existsSync(item.capture), false);
});

test('Codex bound client checks Stop after an asynchronous final artifact gate', async t => {
  const item = fixture(t), input = await pending(t, item.env);
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  const result = await new CodexQueueTransport({ env: item.env, connect: item.connect }).attempt(input, 321, async () => {
    await recordCodexBoundary('thread-a', 'non-stop', item.env);
    return true;
  });
  assert.equal(result.signature, 'boundary_not_stopped');
  assert.equal(fs.existsSync(item.capture), false);
});

test('SessionEnd tombstone blocks dispatch during the gate and a late Stop until start or resume', async t => {
  const item = fixture(t), input = await pending(t, item.env);
  const hook = event => codexHookResponse({ session_id: 'thread-a', hook_event_name: event, cwd: item.root },
    () => [], item.env, {}, () => {});
  const transport = new CodexQueueTransport({ env: item.env, connect: item.connect });
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  assert.equal((await transport.attempt(input, 2000, async () => { await hook('SessionEnd'); return true; })).signature, 'boundary_not_stopped');
  assert.equal((await readCodexBoundary('thread-a', item.env)).ended, true);
  for (const event of ['Stop', 'PostToolUse', 'UserPromptSubmit']) {
    await hook(event);
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
  }
  assert.equal((await transport.attempt(input, 2000, async () => true)).signature, 'boundary_not_stopped');
  assert.equal(fs.existsSync(item.capture), false);
  for (const start of ['SessionStart', 'SessionResume']) {
    await hook(start);
    assert.equal((await readCodexBoundary('thread-a', item.env)).ended, undefined);
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    await hook('Stop');
    assert.equal(await codexQueueEligible('thread-a', item.env), true);
    await hook('UserPromptSubmit');
    assert.equal(await codexQueueEligible('thread-a', item.env), false);
    await hook('SessionEnd');
  }
});

test('frozen entry semantic clock cannot freeze the default Codex I/O deadline', async t => {
  const item = fixture(t), input = await pending(t, item.env);
  await recordCodexBoundary('thread-a', 'Stop', item.env);
  const env = { ...item.env, SQUARE_CODEX_BIN: '/must-not-send', SQUARE_NOW_MS: '100' };
  const semanticClock = squareClock(env), transport = await createDefaultWakeTransport(env);
  let wallNow = 1000;
  t.mock.method(Date, 'now', () => wallNow);
  const result = await transport.attempt(input, 321, async () => {
    await Promise.resolve();
    wallNow += 321;
    assert.equal(semanticClock(), 100);
    return true;
  });
  assert.equal(result.signature, 'dispatch_budget_exhausted');
});

test('default Codex transport retains supplied executable and child environment after ambient mutation', async t => {
  const fake = nodeCommandFixture('square-captured-codex', `
    require('node:fs').writeFileSync(process.env.SQUARE_CODEX_ARGS, process.argv.slice(2).join('\\n'));
  `);
  t.after(() => fs.rmSync(fake.root, { recursive: true, force: true }));
  const item = fixture(t), args = path.join(fake.root, 'args'), bin = path.join(fake.root, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${fake.bin}' '${fake.args[0]}' "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, ...item.env, SQUARE_CODEX_BIN: bin, SQUARE_CODEX_ARGS: args, SQUARE_DISABLE_PASEO_WAKE: '1' };
  await recordCodexBoundary('thread-a', 'Stop', env);
  const input = await pending(t, env), transport = await createDefaultWakeTransport(env);
  const previous = process.env.SQUARE_CODEX_BIN;
  process.env.SQUARE_CODEX_BIN = '/missing/ambient-codex';
  t.after(() => { if (previous === undefined) delete process.env.SQUARE_CODEX_BIN; else process.env.SQUARE_CODEX_BIN = previous; });
  // Child startup allowance only; the frozen-clock test separately proves the dispatch deadline.
  await deliverPending({ ...input, transport, timeoutMs: 5000 });
  assert.match(fs.readFileSync(args, 'utf8'), /^queue\n--thread\nthread-a\n--message\n[\s\S]*stored awareness/);
  assert.equal((await input.artifact.read(facts => facts.deliveryEvidence('Bob', input.bob.generation))).value[0].outcome, 'accepted');
});

test('Codex queue classifies known-unsent errors separately from uncertain admission', async t => {
  const item = fixture(t), input = await pending(t, item.env);
  for (const [error, outcome, signature] of [
    [new DeliveryError('unavailable'), 'failed', 'queue_pre_accept_transient'],
    [new DeliveryError('rejected'), 'failed', 'queue_pre_accept_rejected'],
    [new DeliveryError('timeout', true), 'unknown', 'queue_unknown'],
    [new Error('unclassified'), 'unknown', 'queue_unknown'],
  ]) {
    const transport = new CodexQueueTransport({ connect: async () => ({ queue: async () => { throw error; } }) });
    const result = await transport.attempt(input, 5000, async () => true);
    assert.equal(result.outcome, outcome);
    assert.equal(result.signature, signature);
  }
});

test('shared asynchronous CLI sender uses the exact default shape and reports missing executable as unsent', async t => {
  const fake = nodeCommandFixture('square-codex-queue', `
    require('node:fs').writeFileSync(process.env.SQUARE_CODEX_ARGS, process.argv.slice(2).join('\\n'));
  `);
  t.after(() => fs.rmSync(fake.root, { recursive: true, force: true }));
  const env = { ...process.env, SQUARE_CODEX_ARGS: path.join(fake.root, 'args') };
  await sendCodexQueue({ threadId: 'thread-a', message: 'hello' }, { args: fake.args, bin: fake.bin, env });
  assert.deepEqual(fs.readFileSync(env.SQUARE_CODEX_ARGS, 'utf8').trim().split('\n'), ['queue', '--thread', 'thread-a', '--message', 'hello']);
  await assert.rejects(() => sendCodexQueue({ threadId: 'thread-a', message: 'hello' }, { bin: '/missing/codex' }),
    error => error instanceof CodexQueueSendError && error.kind === 'transient' && error.maybeDelivered === false);
});
