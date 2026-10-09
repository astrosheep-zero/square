import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSquareState, writeSquareFile, loadSquare } from '../dist/artifact.js';
import { join } from '../dist/square-actions.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { presentPending } from '../dist/presentation-operations.js';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { openSquare } from '../dist/square-file-adapter.js';

test('release preserves token authority and rejects late or tokenless terminal evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-evidence-fence-'));
  const ledger = new FileHostLedgerPort({ rootPath: root});
  const claim = { location: path.join(root, 'SQUARE.square'), participant: 'Bob', session: 's', activity: 'act/1', kind: 'presentation' };
  try {
    const first = await ledger.claimEvidence({ ...claim, leaseMs: 10, now: 1 });
    const second = await ledger.claimEvidence({ ...claim, leaseMs: 10, now: 11 });
    assert.equal(first.status, 'acquired');
    assert.equal(second.status, 'acquired');
    await ledger.releaseEvidence({ ...claim, claimToken: second.claimToken, signature: 'presentation_already_recorded', message: 'suppressed by existing presentation', diagnostic: { outcome: 'presented' }, now: 12 });
    await ledger.appendEvidence({ ...claim, outcome: 'presented', claimToken: second.claimToken, at: 13 });
    await ledger.appendEvidence({ ...claim, outcome: 'failed', claimToken: first.claimToken, at: 13 });
    await ledger.appendEvidence({ ...claim, outcome: 'failed', claimToken: 'forged-token', at: 13 });
    await ledger.appendEvidence({ ...claim, outcome: 'failed', claimToken: '', at: 13 });
    await ledger.appendEvidence({ ...claim, kind: 'wake', outcome: 'failed', routeKind: 'paseo', attemptN: 1, claimToken: 'forged-token', at: 13 });
    assert.deepEqual(await ledger.listEvidence({ ...claim, now: 13 }), []);
    assert.deepEqual(await ledger.listEvidence({ ...claim, kind: 'wake', now: 13 }), []);
    const released = await ledger.listEvidence({ ...claim, includeReleased: true, now: 13 });
    assert.deepEqual(released.map(({ outcome, signature, message, diagnostic }) => [outcome, signature, message, diagnostic]), [
      ['released', 'presentation_already_recorded', 'suppressed by existing presentation', { outcome: 'presented' }],
    ]);
    const rows = fs.readFileSync(path.join(root, 'evidence.ndjsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map((row) => [row.outcome, row.claimToken]), [['released', second.claimToken]]);
    const replacement = await ledger.claimEvidence({ ...claim, leaseMs: 10, now: 14 });
    assert.equal(replacement.status, 'acquired');
    assert.notEqual(replacement.claimToken, second.claimToken);
    await ledger.appendEvidence({ ...claim, outcome: 'presented', claimToken: second.claimToken, at: 15 });
    await ledger.appendEvidence({ ...claim, outcome: 'presented', claimToken: replacement.claimToken, at: 15 });
    assert.deepEqual((await ledger.listEvidence({ ...claim, now: 15 })).map((row) => [row.outcome, row.claimToken]), [['presented', replacement.claimToken]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('evidence claims use a fresh lease clock at each acquisition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-evidence-clock-'));
  let now = 100;
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => now });
  const claim = { location: path.join(root, 'SQUARE.square'), participant: 'Bob', session: 's', activity: 'act/1', kind: 'presentation' };
  try {
    const first = await ledger.claimEvidence({ ...claim, leaseMs: 10 });
    await ledger.releaseEvidence({ ...claim, claimToken: first.claimToken });
    now = 250;
    const second = await ledger.claimEvidence({ ...claim, leaseMs: 10 });
    assert.equal(second.status, 'acquired');
    const busy = await ledger.claimEvidence({ ...claim, leaseMs: 10, now: 259 });
    assert.equal(busy.status, 'busy');
    assert.equal(busy.record.expiresAt, 260);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('accepted wake evidence survives retention only while attention is pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-evidence-retention-'));
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => 10 * 86400000 });
  const attention = { squarePath: path.join(root, 'SQUARE.square'), recipient: 'Bob', actIndex: 1 };
  const row = { location: attention.squarePath, participant: 'Bob', session: 's', activity: 'act/1', kind: 'wake', outcome: 'accepted', at: 1 };
  try {
    const claim = await ledger.claimWakeAttempt({ attention, session: 's', routeKind: 'paseo', leaseMs: 10, now: 1 });
    assert.equal(claim.status, 'acquired');
    await ledger.transitionWakeAttempt({ attention, session: 's', claimToken: claim.claimToken, leaseMs: 10, now: 1 });
    await ledger.appendEvidence({ ...row, routeKind: 'paseo', attemptN: claim.attemptN, claimToken: claim.claimToken });
    assert.equal((await ledger.listEvidence({ ...row, now: 10 * 86400000 })).length, 1);
    await ledger.gcEvidence({ before: 2, pendingWakeActivities: ['act/1'] });
    assert.equal((await ledger.listEvidence({ ...row, now: 10 * 86400000 })).length, 1);
    await ledger.gcEvidence({ before: 2, pendingWakeActivities: [] });
    assert.equal((await ledger.listEvidence({ ...row, now: 10 * 86400000 })).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('possibly-sent wake evidence stays readable past retention without native delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-evidence-aged-wake-'));
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => 1 });
  const attention = { squarePath: path.join(root, 'SQUARE.square'), recipient: 'Bob', actIndex: 1 };
  const row = { location: attention.squarePath, participant: 'Bob', session: 's', activity: 'act/1', kind: 'wake', outcome: 'unknown', at: 1 };
  const aged = 10 * 86400000;
  try {
    const claim = await ledger.claimWakeAttempt({ attention, session: 's', routeKind: 'paseo', leaseMs: 10, now: 1 });
    assert.equal(claim.status, 'acquired');
    await ledger.transitionWakeAttempt({ attention, session: 's', claimToken: claim.claimToken, leaseMs: 10, now: 1 });
    await ledger.appendEvidence({ ...row, routeKind: 'paseo', attemptN: claim.attemptN, claimToken: claim.claimToken });
    assert.deepEqual((await ledger.listWakeAttempts({ attention, now: aged })).map((attempt) => [attempt.outcome, attempt.attemptN]), [['unknown', 1]]);
    await ledger.gcEvidence({ before: 2, pendingWakeActivities: ['act/1'] });
    assert.equal((await ledger.listWakeAttempts({ attention, now: aged })).length, 1);
    await ledger.gcEvidence({ before: 2, pendingWakeActivities: [] });
    assert.equal((await ledger.listWakeAttempts({ attention, now: aged })).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('wake attempts have exactly one acquisition path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-one-authority-'));
  const ledger = new FileHostLedgerPort({ rootPath: root });
  const attention = { squarePath: path.join(root, 'SQUARE.square'), recipient: 'Bob', actIndex: 2 };
  try {
    const refused = await ledger.claimEvidence({ location: attention.squarePath, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', leaseMs: 10 });
    assert.equal(refused.status, 'degraded');
    assert.match(String(refused.error), /claimWakeAttempt/);
    const claimed = await ledger.claimWakeAttempt({ attention, session: 'wake-session', routeKind: 'paseo', leaseMs: 10, now: 1 });
    assert.equal(claimed.status, 'acquired');
    assert.equal((await ledger.listWakeAttempts({ attention, now: 1 })).length, 1);
    // The durable send transition is fenced: a native preparation cannot bypass it.
    const prepared = await ledger.prepareNativeWake({ location: attention.squarePath, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', routeKind: 'claude-native', attemptN: claimed.attemptN, claimToken: claimed.claimToken, nativeDelivery: { harness: 'claude', endpoint: '/tmp/native.sock', payload: 'payload', epoch: 1 } });
    assert.equal(prepared, false);
    await ledger.transitionWakeAttempt({ attention, session: 'wake-session', claimToken: claimed.claimToken, leaseMs: 10, now: 1 });
    assert.equal(await ledger.prepareNativeWake({ location: attention.squarePath, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', routeKind: 'claude-native', attemptN: claimed.attemptN, claimToken: claimed.claimToken, nativeDelivery: { harness: 'claude', endpoint: '/tmp/native.sock', payload: 'payload', epoch: 1 } }), true);
    assert.equal(await ledger.transitionWakeAttempt({ attention, session: 'wake-session', claimToken: claimed.claimToken, leaseMs: 10, now: 2 }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('activity-scoped wake results ignore older pending attention without routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-activity-scope-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'join', actor: 'Carol', at: 3, index: 2 },
    { kind: 'say', actor: 'Alice', at: 4, body: 'older @Bob', mentions: ['Bob'], index: 3 },
    { kind: 'say', actor: 'Alice', at: 5, body: 'current @Carol', mentions: ['Carol'], index: 4 },
  );
  state.runtime.nextActIndex = 5;
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  const square = await openSquare(location, { hostLedger: ledger });
  try {
    const result = await deliverPending({
      artifact: square.artifact,
      hostLedger: ledger,
      transport: { attempt: async () => ({ outcome: 'accepted' }) },
      location,
      activity: 4,
      now: 6,
    });
    assert.deepEqual(result, { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 });
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all not-capable candidates classify one attention and persist no attempts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-all-not-capable-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 },
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-b', channel: 'codex', kind: 'codex-queue', address: { threadId: 'b' }, updatedAt: 3 },
  ];
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-b', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'b' } }, updatedAt: 3 });
  const square = await openSquare(location, { hostLedger: ledger });
  try {
    const result = await deliverPending({
      artifact: square.artifact,
      hostLedger: ledger,
      transport: { probe: async () => false, attempt: async () => ({ outcome: 'accepted' }) },
      location,
      now: 10,
    });
    assert.deepEqual(result, { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 });
    assert.deepEqual(await ledger.listWakeAttempts({ attention: { squarePath: location, recipient: 'Bob', actIndex: 2 }, now: 10 }), []);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent sessions serialize one attention to one transport call', { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-single-owner-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 },
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-b', channel: 'paseo', kind: 'paseo', address: { agentId: 'b' }, updatedAt: 3 },
  ];
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-b', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'b' } }, updatedAt: 3 });
  const left = await openSquare(location, { hostLedger: ledger });
  const right = await openSquare(location, { hostLedger: ledger });
  let calls = 0;
  const transport = { attempt: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { outcome: 'accepted' }; } };
  try {
    const results = await Promise.all([
      deliverPending({ artifact: left.artifact, hostLedger: ledger, transport, location, now: 10 }),
      deliverPending({ artifact: right.artifact, hostLedger: ledger, transport, location, now: 10 }),
    ]);
    assert.equal(calls, 1);
    assert.equal(results.reduce((sum, result) => sum + result.accepted, 0), 1);
  } finally {
    await Promise.all([left.artifact.close(), right.artifact.close()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh terminal attempt prevents fallback when the projection clock is stale', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-fresh-terminal-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 },
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-b', channel: 'paseo', kind: 'paseo', address: { agentId: 'b' }, updatedAt: 3 },
  ];
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-b', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'b' } }, updatedAt: 3 });
  const square = await openSquare(location, { hostLedger: ledger });
  let calls = 0;
  const transport = { attempt: async () => { calls += 1; return { outcome: 'accepted' }; } };
  try {
    const first = await deliverPending({ artifact: square.artifact, hostLedger: ledger, transport, location, now: 10 });
    const second = await deliverPending({ artifact: square.artifact, hostLedger: ledger, transport, location, now: 10 });
    assert.equal(calls, 1);
    assert.equal(first.accepted, 1);
    assert.equal(second.accepted, 0);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a local binding without a route still matches its artifact route', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-binding-route-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  state.routes = [{ location: fs.realpathSync.native(location), participant: 'Bob', sessionId: 'local-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'local-agent' }, updatedAt: 3 }];
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'local-session', channel: 'claude-code', route: { kind: 'paseo', address: { agentId: 'local-agent' } }, updatedAt: 3 });
  const square = await openSquare(location, { hostLedger: ledger });
  let calls = 0;
  try {
    const result = await deliverPending({ artifact: square.artifact, hostLedger: ledger, transport: { attempt: async () => { calls += 1; return { outcome: 'accepted' }; } }, location, now: 10 });
    assert.equal(calls, 1);
    assert.deepEqual(result, { attempted: 1, accepted: 1, failed: 0, unknown: 0, notCapable: 0 });
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attention caught after claim is not sent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-final-boundary-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  state.routes = [{ location: fs.realpathSync.native(location), participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 }];
  await writeSquareFile(location, state);
  const base = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  await base.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  let calls = 0;
  let artifactRef;
  const ledger = Object.create(base);
  ledger.transitionWakeAttempt = async (input) => {
    const transitioned = await base.transitionWakeAttempt(input);
    if (transitioned) await artifactRef.transact((current) => ({ state: { ...current, routes: [] }, result: undefined }));
    return transitioned;
  };
  const square = await openSquare(location, { hostLedger: base });
  artifactRef = square.artifact;
  try {
    const result = await deliverPending({ artifact: square.artifact, hostLedger: ledger, transport: { attempt: async () => { calls += 1; return { outcome: 'accepted' }; } }, location, now: 10 });
    assert.equal(calls, 0);
    assert.equal(result.accepted, 0);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('presentation claim is exclusive across concurrent executors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-presentation-claim-'));
  const location = path.join(root, 'SQUARE.square');
  const ledgerRoot = path.join(root, 'user-ledger');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: ledgerRoot });
  const left = await openSquare(location, { hostLedger: ledger });
  const right = await openSquare(location, { hostLedger: ledger });
  let calls = 0;
  const sink = { present: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); } };
  try {
    const results = await Promise.all([
      presentPending({ artifact: left.artifact, location, participant: 'Bob', activity: 2, hostLedger: ledger, session: 'same-session', sink }),
      presentPending({ artifact: right.artifact, location, participant: 'Bob', activity: 2, hostLedger: ledger, session: 'same-session', sink }),
    ]);
    assert.equal(calls, 1);
    assert.equal(results.filter((result) => result.presented).length, 1);
    assert.equal((await loadSquare(location)).runtime.observations.Bob['act/2'].state, 'seen');
  } finally {
    await Promise.all([left.artifact.close(), right.artifact.close()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('presentation evidence from an older session does not block a new binding', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-presentation-session-'));
  const location = path.join(root, 'SQUARE.square');
  const ledgerRoot = path.join(root, 'user-ledger');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: ledgerRoot });
  await ledger.appendEvidence({ location, participant: 'Bob', session: 'old-session', activity: 'act/2', kind: 'presentation', outcome: 'presented', at: 4, claimToken: 'old-test' });
  const square = await openSquare(location, { hostLedger: ledger });
  try {
    let calls = 0;
    const result = await presentPending({
      artifact: square.artifact,
      location,
      participant: 'Bob',
      activity: 2,
      hostLedger: ledger,
      session: 'new-session',
      sink: { present: async () => { calls += 1; } },
    });
    assert.equal(result.presented, true);
    assert.equal(calls, 1);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expired dispatch is unknown across sessions and its late accepted completion remains authoritative', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-recovery-'));
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => 100 });
  const attention = { squarePath: path.join(root, 'SQUARE.square'), recipient: 'Bob', actIndex: 2 };
  const request = { attention, session: 'first', routeKind: 'paseo', leaseMs: 10 };
  try {
    const first = await ledger.claimWakeAttempt({ ...request, now: 100 });
    assert.equal(first.status, 'acquired');
    await ledger.transitionWakeAttempt({ ...request, claimToken: first.claimToken, now: 100 });
    assert.equal((await ledger.claimWakeAttempt({ ...request, session: 'other', now: 109 })).status, 'busy');
    const recovered = await ledger.claimWakeAttempt({ ...request, session: 'other', now: 110 });
    assert.equal(recovered.status, 'terminal');
    assert.equal(recovered.record.outcome, 'unknown');
    assert.equal(recovered.record.session, 'first');
    assert.equal(recovered.record.claimToken, first.claimToken);
    assert.equal((await ledger.claimWakeAttempt({ ...request, session: 'other', routeKind: 'codex-queue', now: 111 })).status, 'terminal');
    const completion = { location: attention.squarePath, participant: 'Bob', session: 'first', activity: 'act/2', kind: 'wake', outcome: 'accepted', routeKind: 'paseo', attemptN: first.attemptN, at: 112 };
    await ledger.appendEvidence({ ...completion, claimToken: 'wrong' });
    assert.equal((await ledger.listWakeAttempts({ attention, now: 112 }))[0].outcome, 'unknown');
    await ledger.appendEvidence({ ...completion, claimToken: first.claimToken });
    await ledger.appendEvidence({ ...completion, outcome: 'unknown', claimToken: first.claimToken });
    assert.deepEqual((await ledger.listWakeAttempts({ attention, now: 112 })).map(row => row.outcome), ['accepted']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stale unsent claims can be replaced without letting old tokens touch the successor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-claim-fence-'));
  const ledger = new FileHostLedgerPort({ rootPath: root, now: () => 100 });
  const attention = { squarePath: path.join(root, 'SQUARE.square'), recipient: 'Bob', actIndex: 2 };
  const request = { attention, session: 's', routeKind: 'paseo', leaseMs: 10 };
  try {
    const first = await ledger.claimWakeAttempt({ ...request, now: 100 });
    const second = await ledger.claimWakeAttempt({ ...request, now: 110 });
    assert.equal(second.status, 'acquired');
    assert.notEqual(first.claimToken, second.claimToken);
    assert.equal(await ledger.transitionWakeAttempt({ ...request, claimToken: first.claimToken, now: 111 }), false);
    await ledger.releaseEvidence({ location: attention.squarePath, participant: 'Bob', session: 's', activity: 'act/2', kind: 'wake', claimToken: first.claimToken, now: 111 });
    assert.equal((await ledger.claimWakeAttempt({ ...request, session: 'other', now: 111 })).status, 'busy');
    assert.equal(await ledger.transitionWakeAttempt({ ...request, claimToken: second.claimToken, now: 111 }), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('expired presentation dispatching claim is reclaimed while presented is terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-presentation-lease-'));
  const location = path.join(root, 'SQUARE.square');
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  try {
    const first = await ledger.claimEvidence({ location, participant: 'Bob', session: 'presentation-session', activity: 'act/2', kind: 'presentation', leaseMs: 10, now: 100 });
    assert.equal(first.status, 'acquired');
    const busy = await ledger.claimEvidence({ location, participant: 'Bob', session: 'presentation-session', activity: 'act/2', kind: 'presentation', leaseMs: 10, now: 109 });
    assert.equal(busy.status, 'busy');
    const recovered = await ledger.claimEvidence({ location, participant: 'Bob', session: 'presentation-session', activity: 'act/2', kind: 'presentation', leaseMs: 10, now: 110 });
    assert.equal(recovered.status, 'acquired');
    await ledger.appendEvidence({ location, participant: 'Bob', session: 'presentation-session', activity: 'act/2', kind: 'presentation', outcome: 'presented', at: 111, claimToken: recovered.claimToken });
    const terminal = await ledger.claimEvidence({ location, participant: 'Bob', session: 'presentation-session', activity: 'act/2', kind: 'presentation', leaseMs: 10, now: 500 });
    assert.equal(terminal.status, 'delivered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clipped presentation stays retryable and never records presented evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-presentation-clip-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger')});
  const square = await openSquare(location, { hostLedger: ledger });
  try {
    let calls = 0;
    const sink = { present: async () => { calls += 1; } };
    const first = await presentPending({ artifact: square.artifact, location, participant: 'Bob', activity: 2, hostLedger: ledger, session: 'clip-session', sink, markSeen: false, now: 4 });
    const second = await presentPending({ artifact: square.artifact, location, participant: 'Bob', activity: 2, hostLedger: ledger, session: 'clip-session', sink, markSeen: false, now: 5 });
    assert.equal(first.presented, true);
    assert.equal(second.presented, true);
    assert.equal(calls, 2);
    assert.equal((await loadSquare(location)).runtime.observations.Bob?.['act/2'], undefined);
    const evidence = await ledger.listEvidence({ location, participant: 'Bob', session: 'clip-session', activity: 'act/2', kind: 'presentation' });
    assert.equal(evidence.some((row) => row.outcome === 'presented'), false);
    assert.equal(evidence.at(-1)?.outcome, 'clipped');
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('producer commits artifact before a repository presence permission failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-producer-presence-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  await writeSquareFile(location, state);
  let committedBeforeEnsure = false;
  const ledger = {
    ensurePresence: async () => {
      const snapshot = await loadSquare(location);
      committedBeforeEnsure = snapshot.acts.length > 0;
      throw new Error('read-only host ledger');
    },
  };
  const square = await openSquare(location, { hostLedger: ledger });
  try {
    const result = await join({ artifact: square.artifact, clock: () => 1, location, hostLedger: ledger }, 'Alice');
    assert.equal(result.activity?.kind, 'join');
    assert.equal(committedBeforeEnsure, true);
    assert.equal((await loadSquare(location)).acts.length, 1);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed candidate followed by an accepted candidate is accepted once for its attention', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-attention-result-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 },
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-b', channel: 'codex', kind: 'codex-queue', address: { threadId: 'b' }, updatedAt: 3 },
  ];
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger'), now: () => 10 });
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-b', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'b' } }, updatedAt: 3 });
  const square = await openSquare(location, { hostLedger: ledger });
  let calls = 0;
  try {
    const result = await deliverPending({
      artifact: square.artifact,
      hostLedger: ledger,
      transport: { attempt: async () => (++calls === 1 ? { outcome: 'failed' } : { outcome: 'accepted' }) },
      location,
      now: 10,
    });
    assert.deepEqual(result, { attempted: 2, accepted: 1, failed: 0, unknown: 0, notCapable: 0 });
    assert.deepEqual((await ledger.listWakeAttempts({ attention: { squarePath: location, recipient: 'Bob', actIndex: 2 }, now: 10 })).map((attempt) => attempt.outcome), ['failed', 'accepted']);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('unknown outcome stops fallback across sessions and route kinds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-unknown-owner-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 },
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-b', channel: 'codex', kind: 'codex-queue', address: { threadId: 'b' }, updatedAt: 3 },
  ];
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger'), now: () => 10 });
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  await ledger.ensurePresence({ location, participant: 'Bob', session: 'session-b', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'b' } }, updatedAt: 3 });
  const square = await openSquare(location, { hostLedger: ledger });
  const calls = [];
  try {
    const result = await deliverPending({
      artifact: square.artifact,
      hostLedger: ledger,
      transport: { attempt: async (request) => { calls.push(request.route.kind); return { outcome: calls.length === 1 ? 'unknown' : 'accepted', diagnostic: 'transport timeout' }; } },
      location,
      now: 10,
    });
    assert.deepEqual(calls, ['paseo']);
    assert.deepEqual(result, { attempted: 1, accepted: 0, failed: 0, unknown: 1, notCapable: 0 });
    assert.deepEqual((await ledger.listWakeAttempts({ attention: { squarePath: location, recipient: 'Bob', actIndex: 2 }, now: 10 })).map((attempt) => [attempt.session, attempt.routeKind, attempt.outcome]), [['session-a', 'paseo', 'unknown']]);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('route ledger read failure stays attention-local when a later route accepts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-route-read-failure-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 },
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-b', channel: 'codex', kind: 'codex-queue', address: { threadId: 'b' }, updatedAt: 3 },
  ];
  await writeSquareFile(location, state);
  const base = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger'), now: () => 10 });
  await base.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  await base.ensurePresence({ location, participant: 'Bob', session: 'session-b', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'b' } }, updatedAt: 3 });
  let claims = 0;
  const ledger = Object.create(base);
  ledger.claimWakeAttempt = async (input) => {
    claims += 1;
    if (claims === 1) return { status: 'degraded', error: new Error('wake attempt ledger unavailable') };
    return base.claimWakeAttempt(input);
  };
  const square = await openSquare(location, { hostLedger: base });
  const calls = [];
  try {
    const result = await deliverPending({
      artifact: square.artifact,
      hostLedger: ledger,
      transport: { attempt: async (request) => { calls.push(request.route.kind); return { outcome: 'accepted' }; } },
      location,
      now: 10,
    });
    assert.deepEqual(calls, ['codex-queue']);
    assert.deepEqual(result, { attempted: 1, accepted: 1, failed: 0, unknown: 0, notCapable: 0 });
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('evidence release failures preserve error policy and leave the single attempt occupied', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-release-failure-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'join', actor: 'Carol', at: 3, index: 2 },
    { kind: 'say', actor: 'Alice', at: 4, body: 'hello @Bob and @Carol', mentions: ['Bob', 'Carol'], index: 3 },
  );
  state.runtime.nextActIndex = 4;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 4 },
    { location: canonicalLocation, participant: 'Carol', sessionId: 'session-b', channel: 'codex', kind: 'codex-queue', address: { threadId: 'b' }, updatedAt: 4 },
  ];
  await writeSquareFile(location, state);
  const base = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger'), now: () => 10 });
  await base.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 4 });
  await base.ensurePresence({ location, participant: 'Carol', session: 'session-b', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'b' } }, updatedAt: 4 });
  const ledger = Object.create(base);
  ledger.releaseEvidence = async () => { throw new Error('wake evidence ledger unavailable'); };
  const square = await openSquare(location, { hostLedger: base });
  const attention = (recipient) => ({ squarePath: location, actIndex: 3, recipient });
  try {
    await assert.rejects(
      deliverPending({
        artifact: square.artifact,
        hostLedger: ledger,
        transport: { attempt: async (request) => (request.participant === 'Bob' ? { outcome: 'not-capable' } : { outcome: 'failed', unavailable: true }) },
        location,
        now: 10,
      }),
      /wake evidence ledger unavailable/,
    );
    // No independent lease can be freed when persistence fails; both attempts remain occupied.
    assert.equal((await base.claimWakeAttempt({ attention: attention('Bob'), routeKind: 'paseo', leaseMs: 1000, session: 'session-a' })).status, 'busy');
    assert.equal((await base.claimWakeAttempt({ attention: attention('Carol'), routeKind: 'codex-queue', leaseMs: 1000, session: 'session-b' })).status, 'busy');
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('recovered ambiguous dispatch stops every fallback route', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-ambiguous-owner-'));
  const location = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const canonicalLocation = fs.realpathSync.native(location);
  state.routes = [
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-a', channel: 'paseo', kind: 'paseo', address: { agentId: 'a' }, updatedAt: 3 },
    { location: canonicalLocation, participant: 'Bob', sessionId: 'session-b', channel: 'codex', kind: 'codex-queue', address: { threadId: 'b' }, updatedAt: 3 },
  ];
  await writeSquareFile(location, state);
  const base = new FileHostLedgerPort({ rootPath: path.join(root, 'user-ledger'), now: () => 10 });
  await base.ensurePresence({ location, participant: 'Bob', session: 'session-a', channel: 'paseo', route: { kind: 'paseo', address: { agentId: 'a' } }, updatedAt: 3 });
  await base.ensurePresence({ location, participant: 'Bob', session: 'session-b', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'b' } }, updatedAt: 3 });
  const ledger = base;
  const attention = { squarePath: location, recipient: 'Bob', actIndex: 2 };
  const interrupted = await base.claimWakeAttempt({ attention, session: 'session-a', routeKind: 'paseo', leaseMs: 1, now: 1 });
  await base.transitionWakeAttempt({ attention, session: 'session-a', claimToken: interrupted.claimToken, leaseMs: 1, now: 1 });
  const square = await openSquare(location, { hostLedger: base });
  const calls = [];
  try {
    const result = await deliverPending({
      artifact: square.artifact,
      hostLedger: ledger,
      transport: { attempt: async (request) => { calls.push(request.route.kind); return { outcome: 'accepted' }; } },
      location,
      now: 10,
    });
    assert.deepEqual(calls, []);
    assert.equal(result.attempted, 0);
    assert.equal(result.accepted, 0);
    assert.equal(result.unknown, 0);
    assert.deepEqual((await base.listWakeAttempts({ attention: { squarePath: location, recipient: 'Bob', actIndex: 2 }, now: 10 })).map((attempt) => [attempt.session, attempt.outcome, attempt.signature]), [['session-a', 'unknown', 'worker_interrupted_during_dispatch']]);
  } finally {
    await square.artifact.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
