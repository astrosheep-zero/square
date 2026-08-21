import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyRuntimeState } from '../dist/artifact.js';
import { deliveryDelta } from '../dist/activity-feed.js';
import { coreActivities, coreHold, coreResume, decideAct, decideJoin } from '../dist/decisions.js';
import { done, express, join } from '../dist/landing.js';
import { createMemoryCell } from '../dist/square-storage.js';

function makeState(overrides = {}) {
  const acts = (overrides.acts ?? []).map((act, index) => ({ ...act, index }));
  return {
    hardCap: 'hardCap' in overrides ? overrides.hardCap : null,
    throttlePerMinute: overrides.throttlePerMinute,
    preamble: [],
    warmup: ['warmup'],
    acts,
    runtime: overrides.runtime ?? { ...emptyRuntimeState(acts.length), nextActIndex: acts.length },
  };
}

test('joining contributes one canonical lifecycle activity for an unknown participant', () => {
  const result = decideJoin(makeState(), 'Alice', 100);

  assert.equal(result.addParticipant, true);
  assert.equal(result.joinedName, 'Alice');
  assert.equal(result.joinAct.kind, 'join');
  assert.equal(result.joinAct.actor, 'Alice');
});

test('pending activities begin after the recipient joined and include directed mentions', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'say', actor: 'Alice', at: 2, body: 'too early @Bob' },
      { kind: 'join', actor: 'Bob', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'live @Bob' },
      { kind: 'say', actor: 'Alice', at: 5, body: 'also @Bob' },
    ],
  });

  assert.deepEqual(
    coreActivities(squareState, { pending: true, viewer: 'Bob' }).map((item) => item.index),
    [3, 4]
  );
});

test('mention history selects directed says for the addressed participant', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'join', actor: 'Cara', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'private @Bob' },
    ],
  });

  assert.deepEqual(coreActivities(squareState, { mention: 'Bob' }).map((item) => item.index), [3]);
  assert.deepEqual(coreActivities(squareState, { mention: 'Cara' }), []);
});

test('directed pending attention survives a cursor that already consumed the public stream', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'pending @Bob' },
      { kind: 'say', actor: 'Bob', at: 4, body: 'self activity' },
    ],
  });
  squareState.runtime.cursors.Bob = { consumedThroughIndex: 3, updatedAt: 4 };

  assert.deepEqual(deliveryDelta(squareState, 'Bob').map((item) => item.index), [2]);
});

test('host controls preserve the requesting actor and body', () => {
  const squareState = makeState({ acts: [{ kind: 'join', actor: 'Host', at: 1 }] });
  const hold = coreHold(squareState, 'Host', 'pause', 10);
  const resume = coreResume(squareState, 'Host', 11);

  assert.deepEqual(
    { kind: hold.kind, actor: hold.actor, body: hold.body },
    { kind: 'hold', actor: 'Host', body: 'pause' }
  );
  assert.deepEqual(
    { kind: resume.kind, actor: resume.actor },
    { kind: 'resume', actor: 'Host' }
  );
});

test('landings advance the actor cursor and never reuse an index', async () => {
  let now = 0;
  const cell = createMemoryCell(makeState());
  const square = { cell, clock: () => (now += 1), location: 'memory' };
  await join(square, 'Alice');
  await express(square, 'Alice', 'hello @Alice', { force: true });
  await done(square, 'Alice', 'bye');

  const stored = (await cell.read()).state;
  assert.equal(stored.runtime.cursors.Alice.consumedThroughIndex, 2);
  assert.deepEqual(stored.acts.map((act) => act.index), [0, 1, 2]);
  await cell.close();
});

test('a valid expression emits the caller as actor and preserves its body, reach, and reply', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
    ],
    runtime: {
      nextActIndex: 2,
      cursors: {},
      deliveryReceipts: {},
      leases: {},
      notifyLeases: {},
    },
  });
  const decision = decideAct(squareState, {
    name: 'Alice',
    body: 'hi @Bob',
    reply: 1,
    force: true,
    now: 3,
  });

  assert.equal(decision.type, 'sent');
  if (decision.type === 'sent') {
    assert.deepEqual(
      { kind: decision.act.kind, actor: decision.act.actor, body: decision.act.body, reach: decision.act.reach, reply: decision.act.reply },
      { kind: 'say', actor: 'Alice', body: 'hi @Bob', reach: undefined, reply: 1 }
    );
  }
});

test('an expression without a mention or bell is invalid', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
    ],
  });

  assert.throws(
    () => decideAct(squareState, { name: 'Alice', body: 'hello everyone', force: true, now: 3 }),
    (error) => error.code === 'invalid_args' && /@mention.*--bell/.test(error.message)
  );

  assert.throws(
    () => decideAct(squareState, { name: 'Alice', body: 'aside', force: true, now: 3 }),
    (error) => error.code === 'invalid_args'
  );
});

test('reply rejects an activity id that has not landed yet', () => {
  const squareState = makeState({ acts: [{ kind: 'join', actor: 'Alice', at: 1, body: '' }] });
  assert.throws(
    () => decideAct(squareState, { name: 'Alice', body: 'late answer', force: true, now: 2, reply: 9 }),
    /Unknown reply activity: act\/9/
  );
});

test('activity history after a timestamp excludes older public activity', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1000, body: '' },
      { kind: 'join', actor: 'Bob', at: 2000, body: '' },
      { kind: 'say', actor: 'Bob', at: 3000, body: 'hello @Alice' },
      { kind: 'done', actor: 'Bob', at: 4000, body: 'bye' },
    ],
  });

  assert.deepEqual(
    coreActivities(squareState, { after: 3500 }).map((item) => ({ index: item.index, kind: item.kind })),
    [{ index: 3, kind: 'done' }],
  );
});

test('activity history at indexes unions their context windows', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'first @Bob' },
      { kind: 'say', actor: 'Bob', at: 4, body: 'second @Alice' },
    ],
  });

  assert.deepEqual(
    coreActivities(squareState, { atIndexes: [2, 3], beforeContext: 0, afterContext: 0 }).map((item) => item.index),
    [2, 3],
  );
});

test('activity history grep searches ids, participant names, and bodies', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'first inventory @Bob' },
      { kind: 'say', actor: 'Bob', at: 4, body: 'facts only @Alice' },
    ],
  });

  assert.deepEqual(coreActivities(squareState, { grep: '^act/2$' }).map((item) => item.body), ['first inventory @Bob']);
  assert.deepEqual(coreActivities(squareState, { grep: '^Bob$' }).map((item) => item.body), ['facts only @Alice']);
  assert.deepEqual(
    coreActivities(squareState, { grep: 'act/2|facts only' }).map((item) => item.index),
    [2, 3],
  );
});
