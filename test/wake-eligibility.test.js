import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { projectBoundaryEligibility } from '../dist/square-projections.js';
import { projectWakeEvidence, projectWakeEligibility, wakeIsEligible } from '../dist/wake-eligibility.js';

const location = '/square/one.square';
const route = (overrides = {}) => ({ location, participant: 'Bob', sessionId: 's', channel: 'paseo', kind: 'paseo', address: { agentId: 'a', extra: 'b' }, updatedAt: 10, extra: {}, ...overrides });
const owner = (overrides = {}) => ({ location, participant: 'bOB', session: 's', channel: 'pi', epoch: 7, ...overrides });
const record = (overrides = {}) => ({ location, participant: 'BOB', session: 'retired', activity: 'act/2', kind: 'wake', outcome: 'failed', routeKind: 'codex-queue', attemptN: 1, at: 20, ...overrides });
const presentation = (overrides = {}) => ({ location, participant: 'bob', sessionId: 's', activity: 'act/2', outcome: 'clipped', ...overrides });
function snapshot(overrides = {}) {
  return {
    location, now: 100, owners: [owner()], wakeRecords: [], presentations: [],
    routes: [route()], pending: [{ index: 2, actor: 'Alice', at: 3, recipient: 'Bob', route: 'mention' }], ...overrides,
  };
}
const request = (overrides = {}) => ({ location, participant: 'bob', actor: 'Alice', activity: 'act/2', route: route(), ...overrides });

test('boundary eligibility reads evidence once for 16 memberships and indexes scoped suppression', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'square-projection-')));
  try {
    const file = path.join(root, 'evidence.ndjsonl');
    let activityReads = 0;
    const inbox = Array.from({ length: 16 }, (_, index) => ({
      squarePath: path.relative(process.cwd(), path.join(root, `square-${index}.square`)), name: 'bOB',
      notifications: [2, 3, 4].map((actIndex) => ({ get actIndex() { activityReads += 1; return actIndex; }, actor: 'Alice', at: 10, route: 'mention', body: 'hello' })),
    }));
    const rows = inbox.flatMap((_membership, index) => {
      const base = { v: 1, at: 10, location: path.join(root, `square-${index}.square`), participant: 'Bob', session: 's', kind: 'presentation' };
      return [
        ...Array.from({ length: 250 }, (_, n) => ({ ...base, activity: `act/${n + 10}`, outcome: 'presented' })),
        { ...base, activity: 'act/2', outcome: 'presented' },
        { ...base, activity: 'act/3', outcome: 'clipped' },
        { ...base, activity: 'act/4', outcome: 'failed' },
        { ...base, activity: 'act/4', outcome: 'presented', session: 'other' },
        { ...base, activity: 'act/4', outcome: 'presented', participant: 'Alice' },
        { ...base, activity: 'act/4', outcome: 'presented', kind: 'wake' },
      ];
    });
    // A foreign square cannot suppress the same activity id in any membership.
    rows.push({ ...rows[0], location: path.join(root, 'other.square'), activity: 'act/4' });
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
    const readFile = fs.readFile;
    let reads = 0;
    t.mock.method(fs, 'readFile', async (target, ...args) => {
      if (target === file) reads += 1;
      return readFile(target, ...args);
    });
    const pending = await projectBoundaryEligibility({ hostLedger: createHostLedgerPort({ rootPath: root, now: () => 100 }), sessionId: 's', inbox });
    assert.equal(reads, 1);
    assert.equal(activityReads, 16 * 3);
    assert.equal(pending.length, 16);
    assert.deepEqual(pending.map((membership) => membership.notifications.map((notification) => notification.actIndex)), Array.from({ length: 16 }, () => [4]));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('wake evidence reads all kinds once per fresh projection', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'square-projection-')));
  try {
    const file = path.join(root, 'evidence.ndjsonl');
    const ledger = createHostLedgerPort({ rootPath: root, now: () => 100 });
    await ledger.ensurePresence(owner());
    const rows = [
      { v: 1, ...record() },
      { v: 1, ...record({ kind: 'presentation', session: 's', outcome: 'clipped' }) },
      { v: 1, ...record({ kind: 'lifecycle', session: 's', outcome: 'presented' }) },
    ];
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
    const readFile = fs.readFile;
    let reads = 0;
    t.mock.method(fs, 'readFile', async (target, ...args) => {
      if (target === file) reads += 1;
      return readFile(target, ...args);
    });
    const input = { ...snapshot(), hostLedger: ledger, now: 100 };
    delete input.owners;
    const first = (await projectWakeEvidence(input)).evidence('Bob', 2);
    assert.equal(reads, 1);
    assert.equal(first.presented, true);
    assert.deepEqual(first.attempts.map((attempt) => attempt.outcome), ['failed']);
    rows[1].outcome = 'failed';
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
    assert.equal(wakeIsEligible((await projectWakeEvidence(input)).evidence('Bob', 2)), true);
    assert.equal(reads, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('empty boundaries skip evidence reads; pending boundary and wake projections propagate failures', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'square-projection-')));
  try {
    const ledger = createHostLedgerPort({ rootPath: root, now: () => 100 });
    const failure = Object.assign(new Error('evidence read failed'), { code: 'EIO' });
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async (target, ...args) => {
      if (target === path.join(root, 'evidence.ndjsonl')) throw failure;
      return readFile(target, ...args);
    });
    assert.deepEqual(await projectBoundaryEligibility({ hostLedger: ledger, sessionId: 's', inbox: [] }), []);
    await assert.rejects(projectBoundaryEligibility({ hostLedger: ledger, sessionId: 's', inbox: [{ squarePath: location, name: 'Bob', notifications: [{ actIndex: 2, actor: 'Alice', at: 10, route: 'mention', body: 'hello' }] }] }), failure);
    await assert.rejects(projectWakeEvidence({ ...snapshot(), hostLedger: ledger, now: 100 }), failure);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// No I/O: deliberately non-existent locations and frozen primary evidence.
test('strict route ownership requires local presence, with optional epoch and channel independence', () => {
  for (const [label, owners, routes, expected] of [
    ['absent owner', [], [route()], false],
    ['foreign owner location', [owner({ location: '/other.square' })], [route()], false],
    ['foreign route location', [owner()], [route({ location: '/other.square' })], false],
    ['optional epoch', [owner()], [route()], true],
    ['matching epoch', [owner()], [route({ epoch: 7 })], true],
    ['mismatched epoch', [owner()], [route({ epoch: 8 })], false],
    ['missing owner epoch', [owner({ epoch: undefined })], [route({ epoch: 7 })], false],
    ['epochless implicit join owns its zero-epoch route', [owner({ epoch: undefined })], [route({ epoch: 0 })], true],
    ['stale presence route key is ignored', [owner({ route: { kind: 'codex-queue', address: { threadId: 'other' } } })], [route()], true],
    ['cancelled epochless route', [owner({ cancelledThrough: 2 })], [route()], false],
  ]) {
    const input = snapshot({ owners });
    input.routes = routes;
    assert.equal(wakeIsEligible(projectWakeEligibility(input).evidence('Bob', 2)), expected, label);
  }
});

test('latest route selection follows the strict join and retains ties with session-local suppression', () => {
  const input = snapshot({ owners: [owner(), owner({ session: 't' })], presentations: [presentation()] });
  input.routes = [route(), route({ sessionId: 't' }), route({ sessionId: 'unowned', updatedAt: 100 })];
  const eligibility = projectWakeEligibility(input);
  assert.equal(eligibility.evidence('Bob', 2).presented, false);
  assert.deepEqual(eligibility.evidence('Bob', 2).attemptableRoutes.map((r) => r.sessionId), ['t']);
  assert.equal(eligibility.currentness(request()).presented, true);
  assert.equal(eligibility.currentness(request({ route: route({ sessionId: 't' }) })).current, true);
  input.presentations.push(presentation({ sessionId: 't' }));
  assert.equal(projectWakeEligibility(input).evidence('Bob', 2).presented, true);
  input.routes.push(route({ sessionId: 't', updatedAt: 11 }));
  assert.equal(projectWakeEligibility(input).currentness(request()).selectedOwner, false);
});

test('route envelopes stay lossless while malformed epochs cannot own a wake and ordered duplicates retain ties', () => {
  const input = snapshot({ owners: [owner(), owner({ session: 't' })] });
  input.routes = [route({ sessionId: 't' }), route({ epoch: '7' }), route({ epoch: null }),
    route({ epoch: [7] }), route({ extra: { legacy: { flag: true } } }), route()];
  const before = structuredClone(input.routes);
  const selected = projectWakeEligibility(input).evidence('Bob', 2).attemptableRoutes;
  assert.deepEqual(selected.map((row) => row.sessionId), ['t', 's', 's']);
  assert.equal(selected.every((row) => row.epoch === undefined && !Object.hasOwn(row, 'extra')), true);
  assert.deepEqual(input.routes, before, 'transport narrowing must not rewrite the artifact envelope');
});

test('captured binding fences do not hide a newly owned superseding route during latest selection', () => {
  const captured = owner();
  const input = snapshot({ owners: [captured, owner({ session: 'new' })], bindings: [captured] });
  input.routes.push(route({ sessionId: 'new', updatedAt: 11 }));
  assert.equal(projectWakeEligibility(input).currentness(request()).selectedOwner, false);
  assert.deepEqual(projectWakeEligibility(input).evidence('Bob', 2).attemptableRoutes, []);
});

test('cancellation suppresses only its owned route and captured batch, not a tied session or new activity', () => {
  const input = snapshot({ owners: [owner({ cancelledThrough: 2 }), owner({ session: 't' })] });
  input.routes.push(route({ sessionId: 't' }));
  input.pending.push({ actor: 'Alice', at: 4, index: 3, recipient: 'Bob', route: 'mention' });
  const eligibility = projectWakeEligibility(input);
  assert.deepEqual(eligibility.evidence('Bob', 2).attemptableRoutes.map((r) => r.sessionId), ['t']);
  assert.deepEqual(eligibility.evidence('Bob', 3).attemptableRoutes.map((r) => r.sessionId), ['s', 't']);
  assert.equal(eligibility.currentness(request()).cancelled, true);
  assert.equal(eligibility.currentness(request({ activity: 'act/3' })).current, true);
});

test('accepted and unknown are attention-wide even after their owner disappears; failures remain retryable', () => {
  for (const outcome of ['failed', 'unknown', 'accepted']) {
    const eligibility = projectWakeEligibility(snapshot({ wakeRecords: [record({ outcome })] }));
    const evidence = eligibility.evidence('Bob', 2);
    assert.equal(evidence.attempts[0].session, 'retired');
    assert.equal(wakeIsEligible(evidence), outcome === 'failed');
    assert.equal(evidence.terminal?.outcome, outcome === 'failed' ? undefined : outcome);
  }
});

test('square, recipient, activity and session scope evidence; dispatch claims and releases are not behavioral attempts', () => {
  const eligibility = projectWakeEligibility(snapshot({
    wakeRecords: [record({ location: '/other.square', outcome: 'accepted' }), record({ participant: 'Alice', outcome: 'unknown' }),
      record({ activity: 'act/3', outcome: 'accepted' }), record({ outcome: 'dispatching' }), record({ outcome: 'released' })],
    presentations: [presentation({ location: '/other.square' }), presentation({ participant: 'Alice' }), presentation({ activity: 'act/3' }), presentation({ sessionId: 'other' })],
  }));
  assert.equal(wakeIsEligible(eligibility.evidence('Bob', 2)), true);
  assert.deepEqual(eligibility.evidence('Bob', 2).attempts, []);
  assert.equal(eligibility.currentness(request({ claimToken: 'own-dispatch' })).current, true);
});

test('one currentness pins pending, strict selected ownership, generation, structural address, cancellation and presentation', () => {
  const input = snapshot();
  assert.equal(projectWakeEligibility(input).currentness(request({ route: route({ address: { extra: 'b', agentId: 'a' } }) })).current, true);
  for (const [label, change, field] of [
    ['generation', (s) => { s.routes[0].epoch = 7; }, 'routePublished'],
    ['removed owner', (s) => { s.owners = []; }, 'sessionBound'],
    ['route address', (s) => { s.routes[0].address.agentId = 'changed'; }, 'routePublished'],
    ['route kind', (s) => { s.routes[0].kind = 'codex-queue'; }, 'routePublished'],
    ['latest owned route', (s) => { s.owners.push(owner({ session: 't' })); s.routes.push(route({ sessionId: 't', updatedAt: 11 })); }, 'selectedOwner'],
    ['cancellation', (s) => { s.owners[0].cancelledThrough = 2; }, 'cancelled'],
    ['consumption', (s) => { s.pending = []; s.seen = [{ recipient: 'Bob', index: 2 }]; }, 'activityPending'],
    ['presentation', (s) => { s.presentations.push(presentation()); }, 'presented'],
  ]) {
    const changed = snapshot(); change(changed);
    const current = projectWakeEligibility(changed).currentness(request());
    assert.equal(current.current, false, label);
    assert.equal(current[field], field === 'cancelled' || field === 'presented', label);
  }
  const epochInput = snapshot({ owners: [owner({ epoch: 8 })] });
  epochInput.routes = [route({ epoch: 7 })];
  assert.equal(projectWakeEligibility(epochInput).currentness(request({ route: route({ epoch: 7 }) })).sessionBound, false);
  assert.equal(projectWakeEligibility(input).currentness(request({ location: '/other.square' })).current, false);
  assert.equal(projectWakeEligibility(input).currentness(request({ participant: 'Alice' })).current, false);
  assert.equal(projectWakeEligibility(input).currentness(request({ activity: 'invalid' })).current, false);
});

test('eligibility indexes its detached pending facts once for repeated observations', () => {
  const input = snapshot();
  let pendingReads = 0;
  const eligibility = projectWakeEligibility({ ...input, get pending() { pendingReads++; return input.pending; } });
  assert.equal(pendingReads, 1, 'the counter must observe construction');
  for (let i = 0; i < 100; i += 1) { eligibility.evidence('Bob', 2); eligibility.currentness(request()); }
  assert.equal(pendingReads, 1);
});
