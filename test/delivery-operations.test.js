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
  const ledger = new FileHostLedgerPort({ userPath: root, localPath: root });
  const claim = { location: path.join(root, 'SQUARE.square'), participant: 'Bob', session: 's', activity: 'act/1', kind: 'presentation' };
  try {
    const first = await ledger.claimEvidence({ ...claim, leaseMs: 10, now: 1 });
    const second = await ledger.claimEvidence({ ...claim, leaseMs: 10, now: 11 });
    assert.equal(first.status, 'acquired');
    assert.equal(second.status, 'acquired');
    await ledger.releaseEvidence({ ...claim, claimToken: second.claimToken, now: 12 });
    await ledger.appendEvidence({ ...claim, outcome: 'presented', claimToken: second.claimToken, at: 13 });
    await ledger.appendEvidence({ ...claim, outcome: 'failed', claimToken: first.claimToken, at: 13 });
    await ledger.appendEvidence({ ...claim, outcome: 'failed', claimToken: 'forged-token', at: 13 });
    await ledger.appendEvidence({ ...claim, outcome: 'failed', claimToken: '', at: 13 });
    await ledger.appendWakeAttempt({ ...claim, kind: 'wake', outcome: 'failed', routeKind: 'paseo', attemptN: 1, claimToken: 'forged-token', at: 13 });
    assert.deepEqual(await ledger.listEvidence({ ...claim, now: 13 }), []);
    assert.deepEqual(await ledger.listEvidence({ ...claim, kind: 'wake', now: 13 }), []);
    const rows = fs.readFileSync(path.join(root, 'evidence.ndjsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map((row) => [row.outcome, row.claimToken]), [['released', second.claimToken]]);
    const replacement = await ledger.claimEvidence({ ...claim, leaseMs: 10, claimToken: 'forged-token', now: 14 });
    assert.equal(replacement.status, 'acquired');
    assert.notEqual(replacement.claimToken, 'forged-token');
    await ledger.appendEvidence({ ...claim, outcome: 'presented', claimToken: second.claimToken, at: 15 });
    await ledger.appendEvidence({ ...claim, outcome: 'presented', claimToken: replacement.claimToken, at: 15 });
    assert.deepEqual((await ledger.listEvidence({ ...claim, now: 15 })).map((row) => [row.outcome, row.claimToken]), [['presented', replacement.claimToken]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('evidence claims use a fresh lease clock at each acquisition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-evidence-clock-'));
  let now = 100;
  const ledger = new FileHostLedgerPort({ userPath: root, localPath: root, now: () => now });
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
  const ledger = new FileHostLedgerPort({ userPath: root, localPath: root, now: () => 10 * 86400000 });
  const row = { location: path.join(root, 'SQUARE.square'), participant: 'Bob', session: 's', activity: 'act/1', kind: 'wake', outcome: 'accepted', at: 1, attemptN: 1 };
  try {
    const claim = await ledger.claimEvidence({ ...row, leaseMs: 10, claimToken: 'retention-test', now: 1 });
    assert.equal(claim.status, 'acquired');
    await ledger.appendEvidence({ ...row, claimToken: claim.claimToken });
    assert.equal((await ledger.listEvidence({ ...row, now: 10 * 86400000 })).length, 1);
    await ledger.gcEvidence({ before: 2, pendingWakeActivities: ['act/1'] });
    assert.equal((await ledger.listEvidence({ ...row, now: 10 * 86400000 })).length, 1);
    await ledger.gcEvidence({ before: 2, pendingWakeActivities: [] });
    assert.equal((await ledger.listEvidence({ ...row, now: 10 * 86400000 })).length, 0);
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
  const ledger = new FileHostLedgerPort({ userPath: path.join(root, 'user-ledger'), localPath: path.join(root, 'local') });
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

test('presentation claim is exclusive across concurrent executors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-presentation-claim-'));
  const location = path.join(root, 'SQUARE.square');
  const userPath = path.join(root, 'user-ledger');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ userPath, localPath: path.join(root, 'local') });
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
  const userPath = path.join(root, 'user-ledger');
  const state = await createSquareState({ force: true, hardCap: null }, '');
  state.acts.push(
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
  );
  state.runtime.nextActIndex = 3;
  await writeSquareFile(location, state);
  const ledger = new FileHostLedgerPort({ userPath, localPath: path.join(root, 'local') });
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

test('unknown wake evidence remains retryable in the same session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-claim-'));
  const location = path.join(root, 'SQUARE.square');
  const ledger = new FileHostLedgerPort({ userPath: path.join(root, 'user-ledger'), localPath: path.join(root, 'local') });
  try {
    const first = await ledger.claimEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', leaseMs: 10, now: 1 });
    assert.equal(first.status, 'acquired');
    await ledger.appendEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', outcome: 'unknown', routeKind: 'paseo', attemptN: 1, at: 1, claimToken: first.claimToken });
    const retry = await ledger.claimEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', leaseMs: 10, now: 2 });
    assert.equal(retry.status, 'acquired');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expired wake dispatching claim is reclaimed after a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-lease-'));
  const location = path.join(root, 'SQUARE.square');
  const ledger = new FileHostLedgerPort({ userPath: path.join(root, 'user-ledger'), localPath: path.join(root, 'local') });
  try {
    const first = await ledger.claimEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', leaseMs: 10, now: 100 });
    assert.equal(first.status, 'acquired');
    const busy = await ledger.claimEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', leaseMs: 10, now: 109 });
    assert.equal(busy.status, 'busy');
    const recovered = await ledger.claimEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', leaseMs: 10, now: 110 });
    assert.equal(recovered.status, 'acquired');
    await ledger.appendEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', outcome: 'accepted', at: 111, claimToken: recovered.claimToken });
    const terminal = await ledger.claimEvidence({ location, participant: 'Bob', session: 'wake-session', activity: 'act/2', kind: 'wake', leaseMs: 10, now: 500 });
    assert.equal(terminal.status, 'delivered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an old wake lease cannot release a replacement lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-dispatch-lease-'));
  const location = path.join(root, 'SQUARE.square');
  const attention = { squarePath: location, recipient: 'Bob', actIndex: 2 };
  const ledger = new FileHostLedgerPort({ userPath: path.join(root, 'user-ledger'), localPath: path.join(root, 'local') });
  try {
    assert.deepEqual(await ledger.claimWakeDispatch({ attention, leaseId: 'lease-a', leaseMs: 10, session: 'wake-session', at: 100 }), { type: 'acquired', leaseId: 'lease-a' });
    assert.deepEqual(await ledger.claimWakeDispatch({ attention, leaseId: 'lease-b', leaseMs: 10, session: 'wake-session', at: 111 }), { type: 'acquired', leaseId: 'lease-b' });
    await ledger.releaseWakeDispatch({ attention, leaseId: 'lease-a', session: 'wake-session', at: 112 });
    assert.deepEqual(await ledger.claimWakeDispatch({ attention, leaseId: 'lease-c', leaseMs: 10, session: 'wake-session', at: 113 }), { type: 'busy' });
    await ledger.releaseWakeDispatch({ attention, leaseId: 'lease-b', session: 'wake-session', at: 114 });
    assert.deepEqual(await ledger.claimWakeDispatch({ attention, leaseId: 'lease-c', leaseMs: 10, session: 'wake-session', at: 115 }), { type: 'acquired', leaseId: 'lease-c' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expired presentation dispatching claim is reclaimed while presented is terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-presentation-lease-'));
  const location = path.join(root, 'SQUARE.square');
  const ledger = new FileHostLedgerPort({ userPath: path.join(root, 'user-ledger'), localPath: path.join(root, 'local') });
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
  const ledger = new FileHostLedgerPort({ userPath: path.join(root, 'user-ledger'), localPath: path.join(root, 'local') });
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
