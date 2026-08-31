import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyRuntimeState } from '../dist/artifact.js';
import { deliveryDelta } from '../dist/activity-feed.js';
import { decideCatch } from '../dist/catch-decisions.js';
import { coreActivities, coreHold, coreIgnore, coreListen, coreListening, coreResume, decideAct, decideJoin } from '../dist/decisions.js';
import { done, express, ignore, join, listen, listening } from '../dist/landing.js';
import { createMemoryCell } from '../dist/square-storage.js';
import { readCursor } from '../dist/runtime.js';

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

test('unknown participant errors identify only the requested name', () => {
  const squareState = makeState({ acts: [{ kind: 'join', actor: 'Alice', at: 1, body: '' }] });
  const unknown = 'Eve';
  const cases = [
    () => coreActivities(squareState, { participants: [unknown] }),
    () => decideAct(squareState, { name: 'Alice', body: 'hello', force: true, now: 2, mentions: [unknown] }),
    () => decideCatch(squareState, unknown, {}, 2),
  ];

  for (const attempt of cases) {
    assert.throws(attempt, (error) => {
      assert.match(error.message, /Unknown (?:participant|mention target)/);
      assert.match(error.message, /@Eve/);
      assert.doesNotMatch(error.message, /Expected one of|@Alice/);
      return true;
    });
  }
});

test('mention history selects historical direct attention for the addressed participant', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'join', actor: 'Cara', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'private @Bob', mentions: ['Bob'] },
      { kind: 'listen', actor: 'Cara', target: 'Alice', at: 5 },
      { kind: 'say', actor: 'Alice', at: 6, body: 'listener attention' },
      { kind: 'ignore', actor: 'Cara', target: 'Alice', at: 7 },
      { kind: 'say', actor: 'Alice', at: 8, body: 'after ignore' },
    ],
  });

  assert.deepEqual(coreActivities(squareState, { mention: 'Bob' }).map((item) => item.index), [3]);
  assert.deepEqual(coreActivities(squareState, { mention: 'Cara' }).map((item) => item.index), [5]);
});

test('directed pending attention survives observations of later activity', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'pending @Bob', mentions: ['Bob'] },
      { kind: 'say', actor: 'Bob', at: 4, body: 'self activity' },
    ],
  });
  squareState.runtime.observations.Bob = { 'act/3': { state: 'seen', at: 4 } };

  assert.deepEqual(deliveryDelta(squareState, 'Bob').map((item) => item.index), [2, 3]);
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
  await express(square, 'Alice', 'hello @Alice', { force: true, mentions: ['Alice'] });
  await done(square, 'Alice', 'bye');

  const stored = (await cell.read()).state;
  assert.equal(readCursor(stored, 'Alice'), 2);
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
      observations: {},
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

test('the library admits a bare expression even when nobody is listening', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
    ],
  });

  const decision = decideAct(squareState, { name: 'Alice', body: 'hello everyone', force: true, now: 3 });
  assert.equal(decision.type, 'sent');
  if (decision.type === 'sent') assert.equal(decision.act.body, 'hello everyone');
});

test('listener decisions are idempotent and preserve active target spelling order', () => {
  const joined = makeState({ acts: [{ kind: 'join', actor: 'Caller', at: 1 }] });
  assert.deepEqual(coreListen(joined, 'caller', 'aku/Riko/7a', 2), {
    kind: 'listen', actor: 'Caller', target: 'aku/Riko/7a', at: 2,
  });

  const listening = makeState({ acts: [
    { kind: 'join', actor: 'Caller', at: 1 },
    { kind: 'listen', actor: 'Caller', target: 'aku/Riko/7a', at: 2 },
    { kind: 'listen', actor: 'Caller', target: 'aku/Momo', at: 3 },
  ] });
  assert.equal(coreListen(listening, 'Caller', 'AKU/riko/7A', 4), undefined);
  assert.deepEqual(coreListening(listening, 'caller'), ['aku/Riko/7a', 'aku/Momo']);
  assert.deepEqual(coreIgnore(listening, 'Caller', 'AKU/RIKO/7A', 5), {
    kind: 'ignore', actor: 'Caller', target: 'AKU/RIKO/7A', at: 5,
  });
  assert.deepEqual(coreIgnore(listening, 'Caller', 'aku/missing', 5), {
    kind: 'ignore', actor: 'Caller', target: 'aku/missing', at: 5,
  });
});

test('mention and listening caps reject without enumerating the roster', () => {
  const targets = Array.from({ length: 11 }, (_value, index) => `Target${index}`);
  const mentionsState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      ...targets.map((actor, index) => ({ kind: 'join', actor, at: index + 2 })),
    ],
  });
  assert.throws(
    () => decideAct(mentionsState, { name: 'Alice', body: 'too many mentions', force: true, now: 20, mentions: targets }),
    (error) => error.code === 'invalid_args'
      && error.message === 'An activity can mention at most 10 participants'
      && !error.message.includes(targets[0])
  );

  const listeningState = makeState({
    acts: [
      { kind: 'join', actor: 'Caller', at: 1 },
      ...targets.slice(0, 10).map((target, index) => ({ kind: 'listen', actor: 'Caller', target, at: index + 2 })),
    ],
  });
  assert.throws(
    () => coreListen(listeningState, 'Caller', targets[10], 20),
    (error) => error.code === 'invalid_args'
      && error.message === 'A participant can listen to at most 10 others'
      && !error.message.includes(targets[0])
  );
});

test('listener landings append only real edge changes', async () => {
  let now = 10;
  const cell = createMemoryCell(makeState({ acts: [{ kind: 'join', actor: 'Caller', at: 1 }] }));
  const square = { cell, clock: () => ++now, location: 'memory' };

  const first = await listen(square, 'Caller', 'aku/riko');
  const repeated = await listen(square, 'caller', 'AKU/RIKO');
  assert.equal(first.activity.kind, 'listen');
  assert.equal(first.activity.target, 'aku/riko');
  assert.equal(repeated.activity, null);
  assert.deepEqual(await listening(square, 'Caller'), ['aku/riko']);

  const removed = await ignore(square, 'Caller', 'aku/riko');
  const absent = await ignore(square, 'Caller', 'aku/riko');
  assert.equal(removed.activity.kind, 'ignore');
  assert.equal(absent.activity, null);
  assert.deepEqual((await cell.read()).state.acts.map((act) => act.kind), ['join', 'listen', 'ignore']);
  await cell.close();
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
      { kind: 'say', actor: 'Bob', at: 3000, body: 'hello @Alice', mentions: ['Alice'] },
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
      { kind: 'say', actor: 'Alice', at: 3, body: 'first @Bob', mentions: ['Bob'] },
      { kind: 'say', actor: 'Bob', at: 4, body: 'second @Alice', mentions: ['Alice'] },
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
      { kind: 'say', actor: 'Alice', at: 3, body: 'first inventory @Bob', mentions: ['Bob'] },
      { kind: 'say', actor: 'Bob', at: 4, body: 'facts only @Alice', mentions: ['Alice'] },
    ],
  });

  assert.deepEqual(coreActivities(squareState, { grep: '^act/2$' }).map((item) => item.body), ['first inventory @Bob']);
  assert.deepEqual(coreActivities(squareState, { grep: '^Bob$' }).map((item) => item.body), ['facts only @Alice']);
  assert.deepEqual(
    coreActivities(squareState, { grep: 'act/2|facts only' }).map((item) => item.index),
    [2, 3],
  );
});
