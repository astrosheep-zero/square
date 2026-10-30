import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchEffect, preparePresentation, presentPrepared, presentPreparedBatch } from '../dist/delivery-effects.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function port(overrides = {}) {
  const completions = [];
  const bound = {
    claim: async () => ({ token: 'opaque-token', ordinal: 7 }),
    current: async () => true,
    settle: async (claim, completion) => { completions.push({ claim, completion }); return true; },
    ...overrides,
  };
  return { bound, completions };
}
async function prepare(bound, payload = 'notice', coverage = 'full') {
  return preparePresentation({ payload, coverage, port: bound });
}

test('dispatch preserves observation separately from refused or failed persistence', async () => {
  const failure = new Error('persistence unavailable');
  for (const [settlement, expected] of [
    [async () => true, { status: 'recorded' }],
    [async () => false, { status: 'not-recorded' }],
    [async () => { throw failure; }, { status: 'error', error: failure }],
  ]) {
    let claims = 0, checks = 0;
    const report = await dispatchEffect({
      claim: async () => { claims++; return { token: 'captured', ordinal: 3 }; },
      current: async () => { checks++; return true; },
      settle: settlement,
    }, async context => {
      assert.deepEqual(context.claim, { token: 'captured', ordinal: 3 });
      assert.equal(context.timeoutMs, 1000);
      assert.ok(context.deadline >= Date.now());
      assert.equal(await context.beforeSend(), true);
      return { outcome: 'accepted', data: { callerProof: 'untouched' } };
    }, { timeoutMs: 1000 });
    assert.equal(claims, 1);
    assert.equal(checks, 2);
    assert.deepEqual(report.observation, { kind: 'returned', result: { outcome: 'accepted', data: { callerProof: 'untouched' } } });
    assert.deepEqual(report.settlement, { completion: { outcome: 'accepted', reason: 'returned', data: { callerProof: 'untouched' } }, persistence: expected });
  }
});

test('dispatch suppression releases custody; unclassified exceptions stay unknown', async () => {
  const error = new Error('sender threw');
  for (const scenario of ['no-claim', 'initial', 'unverifiable', 'cancelled', 'final', 'not-capable', 'exception']) {
    const controller = new AbortController();
    let checks = 0, sends = 0;
    const f = port({
      claim: async () => scenario === 'no-claim' ? undefined : { token: 'captured', ordinal: 0 },
      current: async () => {
        checks++;
        if (scenario === 'unverifiable') throw error;
        if (scenario === 'cancelled') controller.abort();
        return scenario !== 'initial' && (scenario !== 'final' || checks === 1);
      },
    });
    const report = await dispatchEffect(f.bound, async context => {
      sends++;
      if (scenario === 'exception') throw error;
      if (!await context.beforeSend()) return { outcome: 'not-capable' };
      return { outcome: 'not-capable', data: 'proof' };
    }, { timeoutMs: 1000, signal: controller.signal });
    assert.equal(sends, ['final', 'not-capable', 'exception'].includes(scenario) ? 1 : 0, scenario);
    const completion = scenario === 'no-claim' ? undefined
      : scenario === 'exception' ? { outcome: 'unknown', reason: 'threw', error }
      : scenario === 'cancelled' ? { outcome: 'released', reason: 'cancelled' }
      : scenario === 'not-capable' ? { outcome: 'released', reason: 'not-capable', data: 'proof' }
      : { outcome: 'released', reason: 'not-current', phase: scenario === 'final' ? 'final' : 'initial' };
    assert.deepEqual(report.settlement?.completion, completion, scenario);
    assert.equal(f.completions.length, scenario === 'no-claim' ? 0 : 1);
  }
  const f = port();
  assert.deepEqual(await dispatchEffect(f.bound, () => assert.fail('cancelled'), {
    timeoutMs: 1000, signal: AbortSignal.abort(),
  }), { observation: { kind: 'not-invoked' } });
});

test('timeout freezes unknown before settlement; a late true policy gate cannot authorize late I/O or rewrite it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const gate = deferred(), entered = deferred(), sent = deferred(), persistence = deferred();
  let checks = 0, calls = 0, writes = 0, lateGate;
  const f = port({
    current: async () => ++checks === 1 ? true : (entered.resolve(), gate.promise),
    settle: async (_claim, completion) => { writes++; assert.deepEqual(completion, { outcome: 'unknown', reason: 'timeout' }); await persistence.promise; return true; },
  });
  const running = dispatchEffect(f.bound, async context => {
    lateGate = await context.beforeSend();
    if (context.signal?.aborted || Date.now() >= context.deadline) { sent.resolve(); return { outcome: 'not-capable' }; }
    calls++;
    sent.resolve();
    return { outcome: 'accepted' };
  }, { timeoutMs: 10 });
  await entered.promise;
  t.mock.timers.tick(10);
  // Let the timeout choose and enter settlement, which is deliberately still pending.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(writes, 1);
  gate.resolve(true);
  await sent.promise;
  assert.equal(lateGate, true, 'policy and elapsed I/O budget are different facts');
  assert.equal(calls, 0);
  persistence.resolve();
  const report = await running;
  assert.deepEqual(report, { observation: { kind: 'timeout' }, settlement: {
    completion: { outcome: 'unknown', reason: 'timeout' }, persistence: { status: 'recorded' },
  } });
  assert.equal(writes, 1);
});

test('late sender success cannot rewrite an already settled dispatch timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(), sender = deferred();
  const f = port();
  const running = dispatchEffect(f.bound, async () => { entered.resolve(); return sender.promise; }, { timeoutMs: 10 });
  await entered.promise;
  t.mock.timers.tick(10);
  const report = await running;
  sender.resolve({ outcome: 'accepted' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(report.settlement.completion.reason, 'timeout');
  assert.equal(f.completions.length, 1);
  assert.equal(f.completions[0].completion.outcome, 'unknown');
});

test('prepared custody is local, single-use and cannot be concurrently presented or released over an in-flight sink', async () => {
  const f = port(), sink = deferred(), entered = deferred();
  const prepared = await prepare(f.bound);
  assert.equal(await prepared.eligible(), true);
  const running = presentPrepared(prepared, async payload => { assert.equal(payload, 'notice'); entered.resolve(); return sink.promise; });
  await entered.promise;
  assert.equal(await prepared.eligible(), false);
  const release = prepared.release();
  assert.equal(release, prepared.release(), 'cleanup is promise-cached');
  await assert.rejects(presentPrepared(prepared, () => assert.fail('reused')), TypeError);
  sink.resolve('effect');
  const report = await running;
  assert.deepEqual(report.observation, { kind: 'returned', value: 'effect' });
  assert.equal(report.settlements[0].result.completion.outcome, 'presented');
  assert.deepEqual(await release, report.settlements[0].result);
  assert.equal(f.completions.length, 1);
});

test('presentation reports sink truth despite persistence refusal/error and defaults thrown effects to unknown', async () => {
  const error = new Error('sink or store');
  for (const [settlement, status] of [[async () => false, 'not-recorded'], [async () => { throw error; }, 'error']]) {
    const f = port({ settle: settlement });
    const prepared = await prepare(f.bound);
    const report = await presentPrepared(prepared, () => 'externally displayed');
    assert.deepEqual(report.observation, { kind: 'returned', value: 'externally displayed' });
    assert.equal(report.settlements[0].result.completion.outcome, 'presented');
    assert.equal(report.settlements[0].result.persistence.status, status);
    assert.deepEqual(await prepared.release(), report.settlements[0].result);
  }
  for (const [classifyError, outcome] of [[undefined, 'unknown'], [() => { throw Error('bad classifier'); }, 'unknown'], [() => 'failed', 'failed']]) {
    const f = port();
    const prepared = await prepare(f.bound);
    const report = await presentPrepared(prepared, () => { throw error; }, { classifyError });
    assert.deepEqual(report.observation, { kind: 'threw', error, outcome });
    assert.deepEqual(report.settlements[0].result.completion, { outcome, reason: 'threw', error });
    assert.equal(f.completions.length, 1);
  }
});

test('batch rejects invalid custody/subsets and render errors before the sink and releases its unused custody', async () => {
  for (const scenario of ['duplicate', 'foreign', 'used', 'duplicate-subset', 'foreign-subset', 'ineligible-subset', 'render']) {
    const f = port(), g = port({ current: async () => false });
    const a = await prepare(f.bound), b = await prepare(g.bound);
    const used = await prepare(port().bound);
    await used.release();
    const boom = new Error('render');
    const handles = scenario === 'duplicate' ? [a, a, b] : scenario === 'foreign' ? [a, {}, b] : scenario === 'used' ? [a, used, b] : [a, b];
    await assert.rejects(presentPreparedBatch(handles, eligible => {
      if (scenario === 'render') throw boom;
      return { payload: 'batch', included: scenario === 'duplicate-subset' ? [a, a]
        : scenario === 'foreign-subset' ? [used] : scenario === 'ineligible-subset' ? [b] : eligible };
    }, () => assert.fail('must validate before effect')), scenario === 'render' ? error => error === boom : TypeError);
    assert.equal((await a.release()).completion.outcome, 'released', scenario);
    assert.equal((await b.release()).completion.outcome, 'released', scenario);
    assert.equal(f.completions.length, 1, scenario);
    assert.equal(g.completions.length, 1, scenario);
  }
});

test('batch marks all included before settlement callbacks, drains siblings and unused cleanup despite store failures', async () => {
  const pending = deferred(), entered = deferred();
  const controller = new AbortController();
  const storeError = new Error('one store failed');
  let a, b, c, bCleanup;
  const first = port({ settle: async (_claim, completion) => {
    assert.equal(completion.outcome, 'presented');
    // Reentrant cleanup cannot steal the next included item's captured result.
    bCleanup = b.release();
    entered.resolve();
    throw storeError;
  } });
  const second = port({ settle: async (_claim, completion) => {
    assert.equal(completion.outcome, 'clipped');
    await pending.promise;
    return true;
  } });
  const unused = port();
  a = await prepare(first.bound, 'a'); b = await prepare(second.bound, 'b', 'clipped'); c = await prepare(unused.bound, 'c');
  let sends = 0, done = false;
  const running = presentPreparedBatch([a, b, c], eligible => {
    assert.deepEqual(eligible, [a, b, c]);
    return { payload: 'a+b', included: [a, b] };
  }, payload => {
    sends++;
    assert.equal(payload, 'a+b');
    controller.abort(); // no post-effect cancellation veto
    return 42;
  }, { signal: controller.signal }).then(report => { done = true; return report; });
  await entered.promise;
  await Promise.resolve();
  assert.equal(done, false, 'failed sibling must not end resource lifetime early');
  pending.resolve();
  const report = await running;
  assert.equal(sends, 1);
  assert.deepEqual(report.observation, { kind: 'returned', value: 42 });
  assert.equal(report.settlements[0].result.persistence.error, storeError);
  assert.equal(report.settlements[1].result.completion.outcome, 'clipped');
  assert.equal(report.settlements[2].result.completion.outcome, 'released');
  assert.deepEqual(await bCleanup, report.settlements[1].result);
  assert.equal(unused.completions.length, 1);
});

test('batch uncertainty is captured for every included handle and cannot be replaced by cleanup', async () => {
  const error = new Error('sink may have partially effected');
  const a = port(), b = port(), unused = port({ settle: async () => { throw Error('cleanup persistence'); } });
  const handles = [await prepare(a.bound), await prepare(b.bound), await prepare(unused.bound)];
  const report = await presentPreparedBatch(handles, eligible => ({ payload: 'batch', included: eligible.slice(0, 2) }), () => { throw error; });
  assert.deepEqual(report.observation, { kind: 'threw', outcome: 'unknown', error });
  for (const [index, handle] of handles.entries()) {
    const result = report.settlements[index].result;
    assert.deepEqual(await handle.release(), result);
    assert.equal(result.completion.outcome, index < 2 ? 'unknown' : 'released');
  }
  assert.equal(report.settlements[2].result.persistence.status, 'error');
  assert.equal(a.completions.length, 1);
  assert.equal(b.completions.length, 1);
});

test('presentation never races its sink against a timer; cancellation only suppresses before effect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), entered = deferred(), sink = deferred();
  const f = port();
  const prepared = await prepare(f.bound);
  const running = presentPrepared(prepared, async () => { entered.resolve(); await sink.promise; }, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  t.mock.timers.tick(1_000_000);
  assert.equal(f.completions.length, 0);
  sink.resolve();
  const report = await running;
  assert.equal(report.settlements[0].result.completion.outcome, 'presented');
  const cancelled = port();
  assert.equal(await preparePresentation({ payload: 'x', coverage: 'full', port: cancelled.bound }, { signal: controller.signal }), undefined);
  const ready = await prepare(cancelled.bound);
  const suppressed = await presentPrepared(ready, () => assert.fail('cancelled'), { signal: controller.signal });
  assert.equal(suppressed.observation.kind, 'not-invoked');
  assert.equal(suppressed.settlements[0].result.completion.reason, 'cancelled');
});
