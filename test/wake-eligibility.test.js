import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyRuntimeState } from '../dist/artifact.js';
import { projectWakeEligibility, wakeIsEligible } from '../dist/wake-eligibility.js';
import { deriveDeliveryModel } from '../dist/delivery.js';

const location = '/square/one.square';
const route = (overrides = {}) => ({ location, participant: 'Bob', sessionId: 's', channel: 'paseo', kind: 'paseo', address: { agentId: 'a', extra: 'b' }, updatedAt: 10, ...overrides });
const owner = (overrides = {}) => ({ location, participant: 'bOB', session: 's', channel: 'pi', epoch: 7, ...overrides });
const record = (overrides = {}) => ({ location, participant: 'BOB', session: 'retired', activity: 'act/2', kind: 'wake', outcome: 'failed', routeKind: 'codex-queue', attemptN: 1, at: 20, ...overrides });
const presentation = (overrides = {}) => ({ location, participant: 'bob', sessionId: 's', activity: 'act/2', outcome: 'clipped', ...overrides });
function snapshot(overrides = {}) {
  return {
    location, now: 100, owners: [owner()], wakeRecords: [], presentations: [],
    state: { hardCap: null, preamble: [], warmup: [], runtime: { ...emptyRuntimeState(3), nextActIndex: 3 }, routes: [route()], acts: [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'join', actor: 'Bob', at: 2, index: 1 },
      { kind: 'say', actor: 'Alice', mentions: ['Bob'], body: 'hello', at: 3, index: 2 },
    ] }, ...overrides,
  };
}
const request = (overrides = {}) => ({ location, participant: 'bob', actor: 'Alice', activity: 'act/2', route: route(), ...overrides });

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
    ['stale presence route key is ignored', [owner({ route: { kind: 'codex-queue', address: { threadId: 'other' } } })], [route()], true],
    ['cancelled epochless route', [owner({ cancelledThrough: 2 })], [route()], false],
  ]) {
    const input = snapshot({ owners });
    input.state.routes = routes;
    assert.equal(wakeIsEligible(projectWakeEligibility(input).evidence('Bob', 2)), expected, label);
  }
});

test('latest route selection follows the strict join and retains ties with session-local suppression', () => {
  const input = snapshot({ owners: [owner(), owner({ session: 't' })], presentations: [presentation()] });
  input.state.routes = [route(), route({ sessionId: 't' }), route({ sessionId: 'unowned', updatedAt: 100 })];
  const eligibility = projectWakeEligibility(input);
  assert.equal(eligibility.evidence('Bob', 2).presented, false);
  assert.deepEqual(eligibility.evidence('Bob', 2).attemptableRoutes.map((r) => r.sessionId), ['t']);
  assert.equal(eligibility.currentness(request()).presented, true);
  assert.equal(eligibility.currentness(request({ route: route({ sessionId: 't' }) })).current, true);
  input.presentations.push(presentation({ sessionId: 't' }));
  assert.equal(projectWakeEligibility(input).evidence('Bob', 2).presented, true);
  input.state.routes.push(route({ sessionId: 't', updatedAt: 11 }));
  assert.equal(projectWakeEligibility(input).currentness(request()).selectedOwner, false);
});

test('cancellation suppresses only its owned route and captured batch, not a tied session or new activity', () => {
  const input = snapshot({ owners: [owner({ cancelledThrough: 2 }), owner({ session: 't' })] });
  input.state.routes.push(route({ sessionId: 't' }));
  input.state.acts.push({ kind: 'say', actor: 'Alice', mentions: ['Bob'], body: 'new activity', at: 4, index: 3 });
  input.state.runtime.nextActIndex = 4;
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
    ['generation', (s) => { s.state.routes[0].epoch = 7; }, 'routePublished'],
    ['removed owner', (s) => { s.owners = []; }, 'sessionBound'],
    ['route address', (s) => { s.state.routes[0].address.agentId = 'changed'; }, 'routePublished'],
    ['route kind', (s) => { s.state.routes[0].kind = 'codex-queue'; }, 'routePublished'],
    ['latest owned route', (s) => { s.owners.push(owner({ session: 't' })); s.state.routes.push(route({ sessionId: 't', updatedAt: 11 })); }, 'selectedOwner'],
    ['cancellation', (s) => { s.owners[0].cancelledThrough = 2; }, 'cancelled'],
    ['consumption', (s) => { s.state.runtime.observations.Bob = { 'act/2': { state: 'seen', at: 50 } }; }, 'activityPending'],
    ['presentation', (s) => { s.presentations.push(presentation()); }, 'presented'],
  ]) {
    const changed = snapshot(); change(changed);
    const current = projectWakeEligibility(changed).currentness(request());
    assert.equal(current.current, false, label);
    assert.equal(current[field], field === 'cancelled' || field === 'presented', label);
  }
  const epochInput = snapshot({ owners: [owner({ epoch: 8 })] });
  epochInput.state.routes = [route({ epoch: 7 })];
  assert.equal(projectWakeEligibility(epochInput).currentness(request({ route: route({ epoch: 7 }) })).sessionBound, false);
  assert.equal(projectWakeEligibility(input).currentness(request({ location: '/other.square' })).current, false);
  assert.equal(projectWakeEligibility(input).currentness(request({ participant: 'Alice' })).current, false);
  assert.equal(projectWakeEligibility(input).currentness(request({ activity: 'invalid' })).current, false);
});

test('a frozen eligibility snapshot uses the supplied delivery replay without deriving again', () => {
  const input = snapshot();
  let pendingReads = 0;
  const delivery = deriveDeliveryModel(input.state);
  const eligibility = projectWakeEligibility({ ...input, delivery: { ...delivery, pendingFor(recipient) { pendingReads += 1; return delivery.pendingFor(recipient); } } });
  const initial = pendingReads;
  for (let i = 0; i < 100; i += 1) { eligibility.evidence('Bob', 2); eligibility.currentness(request()); }
  assert.equal(pendingReads, initial);
});
