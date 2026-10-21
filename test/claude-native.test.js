import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { writeClaudeNative } from '../dist/packages/agent-delivery/src/claude-native.js';
import { connect } from '../dist/packages/agent-delivery/src/index.js';
import { runClaudeMod } from '../dist/claude-mod.js';
import { observeClaudeDelivery } from '../dist/claude-delivery.js';
import { writeSquareFile, readSquareSnapshot } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { Square } from '../dist/square-api.js';
import { createDefaultWakeTransport } from '../dist/notifications.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { claimSessionTakeover } from '../dist/registry.js';
import { processActNotificationsOnce } from '../dist/notifications.js';
import { closeOpenSquare, openSquare } from '../dist/open-square.js';
import { renderPendingAtBoundary } from '../dist/boundary-presentation.js';
import { sessionInbox } from '../dist/inbox.js';

const supported = { skip: process.platform !== 'darwin' };
async function fixture(t, body = 'hello @Bob') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-native-'));
  const squarePath = path.join(root, 'S.square');
  const endpoint = path.join(root, 'in.sock');
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger'), SQUARE_REGISTRY: path.join(root, 'sessions'), SQUARE_DISABLE_PASEO_WAKE: '1' };
  const acts = [{ kind: 'join', actor: 'Alice', at: 1, index: 0 }, { kind: 'join', actor: 'Bob', at: 2, index: 1 }, { kind: 'say', actor: 'Alice', at: 3, index: 2, body, mentions: ['Bob'] }, { kind: 'say', actor: 'Alice', at: 4, index: 3, body: 'not for Bob', mentions: ['Alice'] }];
  await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['test'], acts: acts.slice(0, 2), runtime: { ...emptyRuntimeState(2), nextActIndex: 2 } });
  const ledger = createHostLedgerPort({ rootPath: env.SQUARE_HOST_LEDGER_ROOT });
  await ledger.ensurePresence({ location: squarePath, participant: 'Bob', session: 'claude-test', channel: 'claude-code' });
  const frames = [];
  let resolveFrame;
  const firstFrame = new Promise((resolve) => { resolveFrame = resolve; });
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (part) => { data += part; if (data.endsWith('\n')) { frames.push(JSON.parse(data)); resolveFrame(frames.at(-1)); data = ''; } });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const coordinate = { sessionId: 'claude-test', cwd: root, version: '2.1.999', endpoint };
  const bridge = async (value) => JSON.parse(await runClaudeMod(JSON.stringify({ ...coordinate, ...value }), env));
  const start = await bridge({ operation: 'start' });
  const square = await openSquare(squarePath);
  try { await square.artifact.transact((facts) => { for (const { index, ...activity } of acts.slice(2)) facts.land(activity); }); }
  finally { await closeOpenSquare(square); }
  return { root, squarePath, env, frames, firstFrame, ledger, bridge, coordinate, start };
}
async function evidence(f) { return f.ledger.listEvidence({ session: f.coordinate.sessionId }); }
async function payload(f) {
  const row = (await evidence(f)).find((row) => row.nativeDelivery);
  assert.ok(row, 'expected a durable native attempt');
  return row.nativeDelivery.payload;
}
async function dispatch(f, activity = 2) { return processActNotificationsOnce(f.squarePath, activity, { env: f.env }); }
async function seen(f, index = 2) { return (await readSquareSnapshot(f.squarePath)).state.runtime.observations.Bob?.[`act/${index}`]?.state; }
async function stored(f, text) { return observeClaudeDelivery(f.coordinate.sessionId, `Another Claude session sent a message:\n${text}\n\nNative peer policy.`, 'stored', f.env); }

// These are local socket/ledger fixtures, not proof of Claude native scheduling.
test('plain native transport prepares tokenless session-targeted NDJSON and only reports write custody', async (t) => {
  const f = await fixture(t);
  assert.equal((await writeClaudeNative({ sessionId: 'target', endpoint: f.coordinate.endpoint }, '字\nbody', { deadline: Date.now() + 1000 })).outcome, 'written');
  await f.firstFrame;
  assert.equal(f.frames.length, 1);
  assert.deepEqual(Object.keys(f.frames[0]).sort(), ['message', 'msgV', 'msg_id', 'priority', 'session_id', 'type']);
  assert.equal(f.frames[0].session_id, 'target');
  assert.deepEqual(f.frames[0].message, { role: 'user', content: '字\nbody' });
  assert.equal((await evidence(f)).length, 0);
  assert.equal((await writeClaudeNative({ sessionId: 'target', endpoint: f.coordinate.endpoint }, 'body', { deadline: Date.now() - 1 })).outcome, 'unavailable');
  assert.equal((await writeClaudeNative({ sessionId: 'target', endpoint: path.join(f.root, 'dead.sock') }, 'body', { deadline: Date.now() + 1000 })).outcome, 'unavailable');
});

test('slow Claude auth stays inside the original deadline and never sends after timeout', async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, 'home');
  const registry = path.join(home, 'sessions');
  fs.mkdirSync(registry, { recursive: true });
  const digest = createHash('sha256').update(f.coordinate.endpoint).digest('hex');
  fs.writeFileSync(path.join(registry, `${process.pid}.${digest}.key`), JSON.stringify({ peerToken: 'a'.repeat(32) }));
  const readdir = fs.promises.readdir;
  const authReads = [];
  t.mock.method(fs.promises, 'readdir', (directory, ...args) => {
    if (directory !== registry) return readdir(directory, ...args);
    const pending = new Promise((resolve) => setTimeout(resolve, 150)).then(() => readdir(directory, ...args));
    authReads.push(pending);
    return pending;
  });
  const stat = fs.promises.stat;
  let scannedKeys = 0;
  t.mock.method(fs.promises, 'stat', (file, ...args) => {
    if (path.dirname(file) === registry) scannedKeys++;
    return stat(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const target = { sessionId: 'target', endpoint: f.coordinate.endpoint, claudeHome: home };
  const started = Date.now();
  await Promise.all([
    assert.rejects(connect({ harness: 'claude', ...target, timeoutMs: 30 }), { code: 'timeout' }),
    writeClaudeNative({ ...target, env: {} }, 'never sent', { deadline: started + 30 }).then((result) => {
      assert.equal(result.outcome, 'unavailable');
      assert.equal(result.code, 'timeout');
    }),
  ]);
  assert.ok(Date.now() - started < 120, 'auth must not hold either caller until the 150ms read completes');
  await Promise.all(authReads);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scannedKeys, 0, 'retired auth must not continue scanning keys');
  assert.deepEqual(f.frames, []);
});

test('cancelling Claude auth aborts its key read without sending', async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, 'home');
  const registry = path.join(home, 'sessions');
  fs.mkdirSync(registry, { recursive: true });
  const digest = createHash('sha256').update(f.coordinate.endpoint).digest('hex');
  const key = path.join(registry, `${process.pid}.${digest}.key`);
  fs.writeFileSync(key, JSON.stringify({ peerToken: 'a'.repeat(32) }));
  const readFile = fs.promises.readFile;
  const signals = [];
  const controller = new AbortController();
  t.mock.method(fs.promises, 'readFile', (file, options) => {
    if (file !== key) return readFile(file, options);
    signals.push(options?.signal);
    if (signals.length === 2) controller.abort();
    return new Promise(() => {});
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const target = { sessionId: 'target', endpoint: f.coordinate.endpoint, claudeHome: home };
  await Promise.all([
    assert.rejects(connect({ harness: 'claude', ...target, signal: controller.signal }), { code: 'aborted' }),
    writeClaudeNative({ ...target, env: {} }, 'never sent', { deadline: Date.now() + 1000, signal: controller.signal }).then((result) => {
      assert.equal(result.outcome, 'unavailable');
      assert.equal(result.code, 'aborted');
    }),
  ]);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal?.aborted));
  assert.deepEqual(f.frames, []);
});

test('manual membership without PUBLIC receives bounded body, admission is not presentation, and full stored preview is idempotent', supported, async (t) => {
  const f = await fixture(t);
  assert.equal(fs.existsSync(path.join(f.root, '.square', 'PUBLIC.square')), false);
  assert.equal(f.start.available, true);
  assert.equal((await dispatch(f)).unknown, 1);
  const text = await payload(f);
  assert.match(text, /hello @Bob/);
  assert.equal(text.replace(/^\[square-inbox:[^\]]+\]\n/, '').replace(/\n\[\/square-inbox:[^\]]+\]$/, ''),
    renderPendingAtBoundary(await sessionInbox('claude-test', f.env)));
  assert.doesNotMatch(text, /not for Bob/);
  assert.equal(await seen(f), undefined);
  assert.equal((await evidence(f)).find((row) => row.kind === 'wake').outcome, 'unknown');
  await observeClaudeDelivery('claude-test', text, 'admitted', f.env);
  assert.equal((await evidence(f)).find((row) => row.kind === 'wake').outcome, 'accepted');
  assert.equal(await seen(f), undefined);
  await stored(f, text);
  await stored(f, text);
  assert.equal(await seen(f), 'seen');
  assert.equal((await evidence(f)).filter((row) => row.kind === 'presentation' && row.outcome === 'presented').length, 1);
  assert.equal((await dispatch(f)).attempted, 0);
});

test('held or timed-out receive remains unknown; late stored clipped payload closes local replay without claiming full consumption', supported, async (t) => {
  const f = await fixture(t, 'x'.repeat(300));
  await dispatch(f);
  const text = await payload(f);
  assert.match(text, /truncated="100 more chars">\nAlice spoke your name\./);
  assert.equal(text.replace(/^\[square-inbox:[^\]]+\]\n/, '').replace(/\n\[\/square-inbox:[^\]]+\]$/, ''),
    renderPendingAtBoundary(await sessionInbox('claude-test', f.env)));
  assert.match(text, /as="Bob" id="act\/2"/);
  assert.doesNotMatch(text, /square --|catch --|square_catch/);
  assert.equal((await dispatch(f)).attempted, 0, 'ambiguous sends are not replayed');
  // No receive success: this is the held-release/late append boundary.
  await stored(f, text);
  await stored(f, text);
  assert.equal(await seen(f), undefined);
  assert.equal((await evidence(f)).filter((row) => row.outcome === 'clipped').length, 1);
  assert.equal((await evidence(f)).find((row) => row.kind === 'wake').outcome, 'accepted');
});

test('unmatched or rewritten text cannot authorize paths, admission, or presentation', supported, async (t) => {
  const f = await fixture(t);
  await dispatch(f);
  const text = await payload(f);
  assert.deepEqual(await observeClaudeDelivery('claude-test', '[square-inbox:invented]\n/tmp/arbitrary.square', 'guard', f.env), { recognized: false, current: false });
  await observeClaudeDelivery('claude-test', text.replace('hello', 'altered'), 'admitted', f.env);
  await stored(f, text.replace('hello', 'altered'));
  assert.equal((await evidence(f)).find((row) => row.kind === 'wake').outcome, 'unknown');
  assert.equal(await seen(f), undefined);
});

test('catch consumption or catch ownership wins over a late append', supported, async (t) => {
  const f = await fixture(t);
  await dispatch(f);
  const text = await payload(f);
  const square = await openSquare(f.squarePath);
  try { await square.artifact.transact((facts) => facts.markSeen('Bob', [2], Date.now())); }
  finally { await closeOpenSquare(square); }
  await stored(f, text);
  assert.equal((await evidence(f)).filter((row) => row.kind === 'presentation').length, 0);
});

test('reload preserves generation; cancellation suppresses old callbacks and unsent work while new activity can deliver', supported, async (t) => {
  const f = await fixture(t);
  const before = (await readSquareSnapshot(f.squarePath)).state.routes[0];
  await dispatch(f);
  const reloaded = await f.bridge({ operation: 'start' });
  assert.deepEqual(reloaded.bindings, f.start.bindings);
  assert.deepEqual((await readSquareSnapshot(f.squarePath)).state.routes[0], before);
  const old = await payload(f);
  await f.bridge({ operation: 'cancel', cancelAt: 4, bindings: f.start.bindings });
  const guard = await observeClaudeDelivery('claude-test', old, 'guard', f.env);
  assert.deepEqual(guard, { recognized: true, current: false });
  await stored(f, old);
  assert.equal(await seen(f), undefined);
  await f.bridge({ operation: 'start', cancelAt: 4, bindings: f.start.bindings });
  assert.equal((await dispatch(f)).attempted, 0);
  const square = await openSquare(f.squarePath);
  try { await square.artifact.transact((facts) => facts.land({ kind: 'say', actor: 'Alice', at: 5, body: 'new @Bob', mentions: ['Bob'] })); }
  finally { await closeOpenSquare(square); }
  assert.equal((await dispatch(f, 4)).unknown, 1);
  const newText = (await evidence(f)).find((row) => row.activity === 'act/4').nativeDelivery.payload;
  await stored(f, newText);
  assert.equal(await seen(f, 4), 'seen');
});

test('a retired token vetoes a mixed live frame before any admission or presentation', supported, async (t) => {
  const f = await fixture(t);
  await dispatch(f);
  const liveText = await payload(f);
  assert.deepEqual(await observeClaudeDelivery('claude-test', liveText, 'guard', f.env), { recognized: true, current: true });
  const claim = await f.ledger.claimWakeAttempt({ attention: { squarePath: f.squarePath, recipient: 'Bob', actIndex: 99 }, session: 'claude-test', routeKind: 'claude-native', leaseMs: 100 });
  assert.equal(claim.status, 'acquired');
  const retiredText = `[square-inbox:${claim.claimToken}]\nstale\n[/square-inbox:${claim.claimToken}]`;
  const correlation = { location: f.squarePath, participant: 'Bob', session: 'claude-test', activity: 'act/99', kind: 'wake', routeKind: 'claude-native', claimToken: claim.claimToken, attemptN: claim.attemptN, nativeDelivery: { harness: 'claude', payload: retiredText, endpoint: f.coordinate.endpoint, epoch: 1 } };
  await f.ledger.prepareNativeWake({ ...correlation, outcome: 'dispatching' });
  await f.ledger.appendEvidence({ ...correlation, outcome: 'unknown' });
  const row = (await f.ledger.listEvidence({ activity: 'act/99' }))[0];
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(row), true);
  const prior = await evidence(f);
  for (const operation of ['guard', 'admitted', 'stored']) {
    assert.deepEqual(await observeClaudeDelivery('claude-test', `${liveText}\n${retiredText}`, operation, f.env), { recognized: true, current: false });
    assert.deepEqual(await evidence(f), prior);
    assert.equal(await seen(f), undefined);
  }
  // The veto is frame-scoped, not a permanent suppression of the live correlation.
  await stored(f, liveText);
  assert.equal(await seen(f), 'seen');
});

test('pinned end epochs retire all manual memberships but never remove a replacement', supported, async (t) => {
  const f = await fixture(t);
  const newer = { ...f.env, CLAUDE_CODE_SESSION_ID: 'claude-test' };
  const result = await claimSessionTakeover(f.squarePath, 'Bob', f.ledger, newer, {}, async () => undefined);
  assert.equal(result.status, 'acquired');
  await f.bridge({ operation: 'end', bindings: f.start.bindings });
  assert.equal((await f.ledger.listPresence({ participant: 'Bob' }))[0].epoch, result.epoch);
  await f.bridge({ operation: 'start' });
  const bindings = await f.ledger.listPresence({ session: 'claude-test' });
  await f.bridge({ operation: 'end', bindings });
  assert.equal((await f.ledger.listPresence({ session: 'claude-test' })).length, 0);
  assert.equal((await readSquareSnapshot(f.squarePath)).state.acts.at(-1).kind, 'done');
  const resumed = await f.bridge({ operation: 'start', resume: true });
  assert.equal(resumed.bindings[0].epoch, result.epoch + 1);
  assert.equal((await readSquareSnapshot(f.squarePath)).state.acts.at(-1).kind, 'join');
});

test('late memberships reconcile without PUBLIC; abort/end discover committed joins and cleanup is participant scoped', supported, async (t) => {
  const f = await fixture(t);
  const scoped = { ...f.env, CLAUDE_CODE_SESSION_ID: 'claude-test' };
  const square = await Square.at({ path: f.squarePath, hostLedger: f.ledger, env: scoped });
  try { await square.join('Late'); }
  finally { await square.close(); }
  const reconciled = await f.bridge({ operation: 'reconcile' });
  assert.equal(reconciled.bindings.length, 2);
  const second = await Square.at({ path: f.squarePath, hostLedger: f.ledger, env: scoped });
  try { await second.join('After'); }
  finally { await second.close(); }
  const cancelled = await f.bridge({ operation: 'cancel', bindings: reconciled.bindings, cancelledBindings: reconciled.bindings, cancelAt: Date.now() });
  assert.equal(cancelled.cancelledBindings.length, 3);
  assert.ok((await f.ledger.listPresence({ participant: 'After' }))[0].cancelledThrough >= 0);
  await f.bridge({ operation: 'end', bindings: f.start.bindings, endedAt: Date.now() });
  assert.equal((await f.ledger.listPresence()).length, 0);
  const state = (await readSquareSnapshot(f.squarePath)).state;
  assert.equal(state.acts.filter((activity) => activity.kind === 'done').length, 3);
  assert.equal(fs.existsSync(path.join(f.root, '.square/PUBLIC.square')), false);
});

test('retained cancellation cannot acquire replacement same-session epochs across repeated reload', supported, async (t) => {
  const f = await fixture(t);
  const at = Date.now();
  await f.bridge({ operation: 'cancel', bindings: f.start.bindings, cancelledBindings: f.start.bindings, cancelAt: at });
  const result = await claimSessionTakeover(f.squarePath, 'Bob', f.ledger, { ...f.env, CLAUDE_CODE_SESSION_ID: 'claude-test' }, {}, async () => undefined);
  assert.equal(result.status, 'acquired');
  const first = await f.bridge({ operation: 'reconcile', bindings: f.start.bindings, cancelledBindings: f.start.bindings, cancelAt: at });
  await f.bridge({ operation: 'reconcile', bindings: first.bindings, cancelledBindings: f.start.bindings, cancelAt: at });
  const owner = (await f.ledger.listPresence({ participant: 'Bob' }))[0];
  assert.equal(owner.epoch, result.epoch);
  assert.equal(owner.cancelledThrough, undefined);
});

test('final native write revalidates catch after durable preparation', supported, async (t) => {
  const f = await fixture(t);
  const prepare = f.ledger.prepareNativeWake.bind(f.ledger);
  f.ledger.prepareNativeWake = async (input) => {
    const prepared = await prepare(input);
    const square = await openSquare(f.squarePath);
    try { await square.artifact.transact((facts) => facts.markSeen('Bob', [2], Date.now())); }
    finally { await closeOpenSquare(square); }
    return prepared;
  };
  const square = await openSquare(f.squarePath, { hostLedger: f.ledger });
  try { await deliverPending({ artifact: square.artifact, hostLedger: f.ledger, transport: await createDefaultWakeTransport(f.ledger, Date.now, f.env, []), location: f.squarePath, activity: 2 }); }
  finally { await closeOpenSquare(square); }
  assert.equal(f.frames.length, 0);
});

test('a mod without a real endpoint publishes no native route and leave memberships intact', async (t) => {
  const f = await fixture(t);
  const result = await f.bridge({ operation: 'start', endpoint: 'relative.sock' });
  assert.equal(result.available, false);
  assert.match(result.diagnostic, /unavailable/);
  assert.equal((await readSquareSnapshot(f.squarePath)).state.routes?.length ?? 0, 0);
  assert.equal((await f.ledger.listPresence({ session: 'claude-test' })).length, 1);
});
