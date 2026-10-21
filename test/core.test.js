import assert from 'node:assert/strict';
import test from 'node:test';

import { directedSuffix } from '../dist/activity-feed.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { decideCatch } from '../dist/catch-decisions.js';
import { coreHold, coreIgnore, coreListen, coreListening, coreParticipants, coreResume, decideAct, decideJoin } from '../dist/decisions.js';
import { renderPresenceLines } from '../dist/presentation.js';
import { presenceAnchor, readCursor } from '../dist/runtime.js';
import { done, express, ignore, join, listen, listening } from '../dist/square-actions.js';
import { createArtifactPort } from '../dist/artifact.js';
import { catchPresence, publicActivities, NON_READ, selectHistory, listPresentation, queryParticipants, queryStatus } from '../dist/views.js';

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

async function selectedHistory(square, query) {
  return (await square.artifact.read((facts) => publicActivities(selectHistory(facts, query, query.limit ?? null, NON_READ, false).activities))).value;
}

function memorySquare(overrides = {}, clock = () => 0) {
  const cell = createArtifactPort(':memory:', makeState(overrides));
  return { cell, square: { artifact: cell, clock, location: 'memory' } };
}

test('participant lists share actual action and receipt times, including a fresh rejoin', async () => {
  const state = makeState({ acts: [
    { kind: 'join', actor: 'Reader', at: 1 },
    { kind: 'join', actor: 'Returning', at: 2 },
    { kind: 'say', actor: 'Returning', at: 3, body: 'old message', mentions: ['Reader'] },
    { kind: 'done', actor: 'Returning', at: 4 },
    { kind: 'join', actor: 'Returning', at: 90000 },
    { kind: 'join', actor: 'Newcomer', at: 120000 },
  ] });
  state.runtime = {
    nextActIndex: 6,
    observations: { Reader: { 'act/2': { state: 'seen', at: 60000 } }, Returning: { 'act/0': { state: 'seen', at: 2 } } },
    leases: { Reader: { leaseId: 'watch', heartbeatAt: 179999, expiresAt: 200000 } },
  };
  const cell = createArtifactPort(':memory:', state);
  const square = { artifact: cell, clock: () => 180000, location: 'memory' };
  try {
    const expected = [['Newcomer', 120000], ['Returning', 90000], ['Reader', 60000]];
    const projections = [
      (await cell.read((facts) => queryParticipants(facts, { location: 'memory', now: 180000, automaticDeliveryAvailable: false }))).value.participants,
      (await cell.read((facts) => queryStatus(facts, { location: 'memory', now: 180000, automaticDeliveryAvailable: false }))).value.participants,
      (await catchPresence(square)).participants,
    ];
    for (const participants of projections) {
      assert.deepEqual(participants.map((p) => [p.name, p.lastActiveAt]), expected);
      const output = renderPresenceLines(participants, 180000).join('\n');
      assert.ok(output.indexOf('@Newcomer') < output.indexOf('@Returning'));
      assert.ok(output.indexOf('@Returning') < output.indexOf('@Reader'));
      assert.match(output, /@Reader.*catching.*2m/);
    }
    assert.deepEqual((await listPresentation(square)).participants, expected.map(([name]) => name));
  } finally {
    await cell.close();
  }
});

test('participant activity includes authored actions and never advances from unrelated activity', async () => {
  for (const action of [
    { kind: 'listen', target: 'Other' },
    { kind: 'ignore', target: 'Other' },
    { kind: 'hold' },
    { kind: 'resume' },
    { kind: 'read', through: 0 },
  ]) {
    const { cell } = memorySquare({ acts: [
      { kind: 'join', actor: 'Actor', at: 1 },
      { kind: 'join', actor: 'Other', at: 2 },
      { ...action, actor: 'Actor', at: 100 },
      { kind: 'say', actor: 'Other', at: 200, body: 'bare', mentions: [] },
    ] });
    try {
      const actor = (await cell.read((facts) => coreParticipants(facts, 300))).value.find((p) => p.name === 'Actor');
      assert.equal(actor.lastActiveAt, 100);
      assert.equal(actor.activityCount, 0);
    } finally {
      await cell.close();
    }
  }
});

test('joining contributes one canonical lifecycle activity for an unknown participant', async () => {
  const { cell } = memorySquare();
  try {
    const result = (await cell.read((facts) => decideJoin(facts, 'Alice', 100))).value;
    assert.deepEqual(result, { joinedName: 'Alice', addParticipant: true, joinAct: { kind: 'join', actor: 'Alice', at: 100 } });
  } finally {
    await cell.close();
  }
});

test('unknown participant errors identify only the requested name', async () => {
  const { cell, square } = memorySquare({ acts: [{ kind: 'join', actor: 'Alice', at: 1 }] });
  const unknown = 'Eve';
  const cases = [
    () => selectedHistory(square, { from: [unknown] }),
    () => cell.transact((facts) => decideAct(facts, { name: 'Alice', body: 'hello', force: true, now: 2, mentions: [unknown] })),
    () => cell.transact((facts) => decideCatch(facts, unknown, {}, 2)),
  ];

  const expectedReasons = ['never_joined', 'not_standing', 'never_joined'];
  for (const [index, attempt] of cases.entries()) {
    await assert.rejects(attempt, (error) => {
      assert.match(error.message, /^@Eve (?:has never stepped into this square|is not standing in this square)/);
      assert.match(error.message, /@Eve/);
      assert.doesNotMatch(error.message, /Expected one of|@Alice/);
      // Recovery reads this fact; the wording above is free to change.
      assert.equal(error.facts?.reason, expectedReasons[index]);
      return true;
    });
  }
  await cell.close();
});

test('mention history selects historical direct attention for the addressed participant', async () => {
  const { cell, square } = memorySquare({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'join', actor: 'Cara', at: 3 },
      { kind: 'say', actor: 'Alice', at: 4, body: 'private @Bob', mentions: ['Bob'] },
      { kind: 'listen', actor: 'Cara', target: 'Alice', at: 5 },
      { kind: 'say', actor: 'Alice', at: 6, body: 'listener attention' },
      { kind: 'ignore', actor: 'Cara', target: 'Alice', at: 7 },
      { kind: 'say', actor: 'Alice', at: 8, body: 'after ignore' },
    ],
  });
  try {
    assert.deepEqual((await selectedHistory(square, { mention: 'Bob' })).map((item) => item.id), ['act/3']);
    assert.deepEqual((await selectedHistory(square, { mention: 'Cara' })).map((item) => item.id), ['act/5']);
  } finally {
    await cell.close();
  }
});

test('directed pending attention survives an unrelated later receipt', async () => {
  const state = makeState({ acts: [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'pending @Bob', mentions: ['Bob'] },
    { kind: 'say', actor: 'Bob', at: 4, body: 'self activity' },
  ] });
  state.runtime = { nextActIndex: 4, observations: { Bob: { 'act/3': { state: 'seen', at: 4 } } }, leases: {} };
  const cell = createArtifactPort(':memory:', state);
  try {
    const facts = (await cell.read((read) => ({
      suffix: directedSuffix(read, 'Bob').map((activity) => activity.index),
      cursor: readCursor(read, 'Bob'),
      unseen: read.directedCount('Bob', { afterIndex: readCursor(read, 'Bob'), unseenOnly: true }),
    }))).value;
    assert.deepEqual(facts, { suffix: [2], cursor: 1, unseen: 1 });
  } finally {
    await cell.close();
  }
});

test('presence rides on own activity or actor-bearing receipts, never orphan coordinates', async () => {
  const state = makeState({ acts: [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'own activity' },
    { kind: 'say', actor: 'Bob', at: 4, body: 'peer activity' },
    { kind: 'hold', at: 5, body: 'actorless hold' },
  ] });
  state.runtime = { nextActIndex: 5, observations: { Alice: { 'act/4': { state: 'seen', at: 50 } } }, leases: {} };
  const cell = createArtifactPort(':memory:', state);
  try {
    assert.equal((await cell.read((facts) => presenceAnchor(facts, 'Alice'))).value, 2);
  } finally {
    await cell.close();
  }
});

test('host controls preserve the requesting actor and body', async () => {
  const { cell } = memorySquare({ acts: [{ kind: 'join', actor: 'Host', at: 1 }] });
  try {
    const controls = (await cell.read((facts) => ({
      hold: coreHold(facts, 'Host', 'pause', 10),
      resume: coreResume(facts, 'Host', 11),
    }))).value;
    assert.deepEqual(
      { kind: controls.hold.kind, actor: controls.hold.actor, body: controls.hold.body },
      { kind: 'hold', actor: 'Host', body: 'pause' }
    );
    assert.deepEqual(
      { kind: controls.resume.kind, actor: controls.resume.actor },
      { kind: 'resume', actor: 'Host' }
    );
  } finally {
    await cell.close();
  }
});

test('landings advance the actor cursor and never reuse an index', async () => {
  let now = 0;
  const cell = createArtifactPort(':memory:', makeState());
  const square = { artifact: cell, clock: () => (now += 1), location: 'memory' };
  try {
    await join(square, 'Alice');
    await express(square, 'Alice', 'hello @Alice', { force: true, mentions: ['Alice'] });
    await done(square, 'Alice');

    const stored = (await cell.read((facts) => ({
      cursor: readCursor(facts, 'Alice'),
      indexes: facts.activityHeads({}, { edge: 'oldest', limit: 10 }).items.map((head) => head.index),
    }))).value;
    assert.equal(stored.cursor, 2);
    assert.deepEqual(stored.indexes, [0, 1, 2]);
  } finally {
    await cell.close();
  }
});

test('a valid expression emits the caller as actor and preserves its body, reach, and reply', async () => {
  const { cell } = memorySquare({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
    ],
  });
  try {
    const decision = (await cell.read((facts) => decideAct(facts, {
      name: 'Alice',
      body: 'hi @Bob',
      reply: 1,
      force: true,
      now: 3,
    }))).value;

    assert.equal(decision.type, 'sent');
    if (decision.type === 'sent') {
      assert.deepEqual(
        { kind: decision.act.kind, actor: decision.act.actor, body: decision.act.body, reach: decision.act.reach, reply: decision.act.reply },
        { kind: 'say', actor: 'Alice', body: 'hi @Bob', reach: undefined, reply: 1 }
      );
    }
  } finally {
    await cell.close();
  }
});

test('the library admits a bare expression even when nobody is listening', async () => {
  const { cell } = memorySquare({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
    ],
  });
  try {
    const decision = (await cell.read((facts) => decideAct(facts, { name: 'Alice', body: 'hello everyone', force: true, now: 3 }))).value;
    assert.equal(decision.type, 'sent');
    if (decision.type === 'sent') assert.equal(decision.act.body, 'hello everyone');
  } finally {
    await cell.close();
  }
});

test('listener decisions are idempotent and preserve active target spelling order', async () => {
  const joined = memorySquare({ acts: [{ kind: 'join', actor: 'Caller', at: 1 }] });
  const listeningCell = memorySquare({ acts: [
    { kind: 'join', actor: 'Caller', at: 1 },
    { kind: 'listen', actor: 'Caller', target: 'aku/Riko/7a', at: 2 },
    { kind: 'listen', actor: 'Caller', target: 'aku/Momo', at: 3 },
  ] });
  try {
    assert.deepEqual(
      (await joined.cell.read((facts) => coreListen(facts, 'caller', 'aku/Riko/7a', 2))).value,
      { kind: 'listen', actor: 'Caller', target: 'aku/Riko/7a', at: 2 },
    );
    const readings = (await listeningCell.cell.read((facts) => ({
      repeated: coreListen(facts, 'Caller', 'AKU/riko/7A', 4),
      listening: coreListening(facts, 'caller'),
      ignored: coreIgnore(facts, 'Caller', 'AKU/RIKO/7A', 5),
      missing: coreIgnore(facts, 'Caller', 'aku/missing', 5),
    }))).value;
    assert.equal(readings.repeated, undefined);
    assert.deepEqual(readings.listening, ['aku/Riko/7a', 'aku/Momo']);
    assert.deepEqual(readings.ignored, { kind: 'ignore', actor: 'Caller', target: 'AKU/RIKO/7A', at: 5 });
    assert.deepEqual(readings.missing, { kind: 'ignore', actor: 'Caller', target: 'aku/missing', at: 5 });
  } finally {
    await joined.cell.close();
    await listeningCell.cell.close();
  }
});

test('mention and listening caps reject without enumerating the roster', async () => {
  const targets = Array.from({ length: 11 }, (_value, index) => `Target${index}`);
  const mentionsCell = memorySquare({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      ...targets.map((actor, index) => ({ kind: 'join', actor, at: index + 2 })),
    ],
  });
  const listeningCell = memorySquare({
    acts: [
      { kind: 'join', actor: 'Caller', at: 1 },
      ...targets.slice(0, 10).map((target, index) => ({ kind: 'listen', actor: 'Caller', target, at: index + 2 })),
    ],
  });
  try {
    await assert.rejects(
      () => mentionsCell.cell.read((facts) => decideAct(facts, { name: 'Alice', body: 'too many mentions', force: true, now: 20, mentions: targets })),
      (error) => error.code === 'invalid_args'
        && error.message === 'An activity can mention at most 10 participants'
        && !error.message.includes(targets[0])
    );
    const deduplicated = (await mentionsCell.cell.read((facts) => decideAct(facts, {
      name: 'Alice', body: 'deduplicated', force: true, now: 20, mentions: [...targets.slice(0, 10), 'TARGET0'],
    }))).value;
    assert.equal(deduplicated.type, 'sent');

    await assert.rejects(
      () => listeningCell.cell.read((facts) => coreListen(facts, 'Caller', targets[10], 20)),
      (error) => error.code === 'invalid_args'
        && error.message === 'A participant can listen to at most 10 others'
        && !error.message.includes(targets[0])
    );
    assert.equal((await listeningCell.cell.read((facts) => coreListen(facts, 'Caller', 'TARGET0', 20))).value, undefined);
  } finally {
    await mentionsCell.cell.close();
    await listeningCell.cell.close();
  }
});

test('listener landings append only real edge changes', async () => {
  let now = 10;
  const cell = createArtifactPort(':memory:', makeState({ acts: [{ kind: 'join', actor: 'Caller', at: 1 }] }));
  const square = { artifact: cell, clock: () => ++now, location: 'memory' };
  try {
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
    const kinds = (await cell.read((facts) => facts.activityHeads({}, { edge: 'oldest', limit: 10 }).items.map((head) => head.kind))).value;
    assert.deepEqual(kinds, ['join', 'listen', 'ignore']);
  } finally {
    await cell.close();
  }
});

test('reply rejects an activity id that has not landed yet', async () => {
  const { cell } = memorySquare({ acts: [{ kind: 'join', actor: 'Alice', at: 1 }] });
  try {
    await assert.rejects(
      () => cell.read((facts) => decideAct(facts, { name: 'Alice', body: 'late answer', force: true, now: 2, reply: 9 })),
      /Unknown reply activity: act\/9/
    );
  } finally {
    await cell.close();
  }
});

test('admission refuses held, capped, throttled and quota-exhausted says', async () => {
  const held = memorySquare({ acts: [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'hold', actor: 'Host', at: 2, body: 'pause' },
  ] });
  const capped = memorySquare({ hardCap: 1, acts: [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'say', actor: 'Alice', at: 2, body: 'one' },
  ] });
  const throttled = memorySquare({ throttlePerMinute: 1, acts: [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'say', actor: 'Alice', at: 10, body: 'one' },
  ] });
  const bell = memorySquare({ acts: [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'say', actor: 'Alice', at: 1000, body: 'hear me', reach: 'bell' },
  ] });
  try {
    const decide = (cell, now, extra = {}) => cell.read((facts) => decideAct(facts, { name: 'Alice', body: 'again', force: true, now, ...extra })).then((result) => result.value);
    assert.deepEqual(await decide(held.cell, 20), { type: 'held', reason: 'pause' });
    assert.deepEqual(await decide(capped.cell, 20), { type: 'capped', count: 1, hardCap: 1 });
    const throttledDecision = await decide(throttled.cell, 1000);
    assert.equal(throttledDecision.type, 'throttled');
    assert.equal(throttledDecision.delayMs, 10 + 60000 - 1000);
    assert.deepEqual(await decide(bell.cell, 2000, { reach: 'bell' }), { type: 'bell_quota', nextAt: 1000 + 3600000 });
    // The same bell becomes eligible exactly at the end of its quota window.
    assert.equal((await decide(bell.cell, 1000 + 3600000, { reach: 'bell' })).type, 'sent');
  } finally {
    await held.cell.close();
    await capped.cell.close();
    await throttled.cell.close();
    await bell.cell.close();
  }
});

test('activity history after a timestamp excludes older public activity', async () => {
  const { cell, square } = memorySquare({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1000 },
      { kind: 'join', actor: 'Bob', at: 2000 },
      { kind: 'say', actor: 'Bob', at: 3000, body: 'hello @Alice', mentions: ['Alice'] },
      { kind: 'done', actor: 'Bob', at: 4000, body: 'bye' },
    ],
  });
  try {
    const selected = (await cell.read((facts) => selectHistory(facts, { since: 3500 }, 10, undefined))).value.activities;
    assert.deepEqual(selected.map((activity) => ({ index: activity.index, kind: activity.kind })), [{ index: 3, kind: 'done' }]);
  } finally {
    await cell.close();
  }
});

test('activity history at indexes unions their context windows', async () => {
  const { cell, square } = memorySquare({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'say', actor: 'Alice', at: 3, body: 'first @Bob', mentions: ['Bob'] },
      { kind: 'say', actor: 'Bob', at: 4, body: 'second @Alice', mentions: ['Alice'] },
    ],
  });
  try {
    const selected = (await cell.read((facts) => selectHistory(facts, { at: ['act/2', 'act/3'], contextBefore: 0, contextAfter: 0 }, null, undefined))).value.activities;
    assert.deepEqual(selected.map((activity) => activity.index), [2, 3]);
  } finally {
    await cell.close();
  }
});

test('activity history grep searches ids, participant names, and bodies', async () => {
  const { cell, square } = memorySquare({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'say', actor: 'Alice', at: 3, body: 'first inventory @Bob', mentions: ['Bob'] },
      { kind: 'say', actor: 'Bob', at: 4, body: 'facts only @Alice', mentions: ['Alice'] },
    ],
  });
  try {
    assert.deepEqual((await selectedHistory(square, { grep: '^act/2$' })).map((item) => item.body), ['first inventory @Bob']);
    assert.deepEqual((await selectedHistory(square, { grep: '^Bob$' })).map((item) => item.body), ['facts only @Alice']);
    assert.deepEqual((await selectedHistory(square, { grep: 'act/2|facts only' })).map((item) => item.id), ['act/2', 'act/3']);
  } finally {
    await cell.close();
  }
});

test('catch pages unseen directed activity and keeps the continuous cursor behind a gap', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
    ...Array.from({ length: 25 }, (_, index) => ({ kind: 'say', actor: index % 2 === 0 ? 'Bob' : 'Cara', at: index + 4, body: `message ${index} @Alice`, mentions: ['Alice'] })),
  ];
  const first = createArtifactPort(':memory:', makeState({ acts }));
  try {
    const page = (cell, options, at) => cell.transact((facts) => decideCatch(facts, 'Alice', options, at)).then((result) => result.value);
    const one = await page(first, { limit: 10 }, 100);
    assert.deepEqual(one.activities.map((item) => item.index), Array.from({ length: 10 }, (_, index) => index + 3));
    assert.equal(one.remaining, 15);
    const two = await page(first, { limit: 10 }, 101);
    assert.deepEqual(two.activities.map((item) => item.index), Array.from({ length: 10 }, (_, index) => index + 13));
    const three = await page(first, { limit: 10 }, 102);
    assert.deepEqual(three.activities.map((item) => item.index), [23, 24, 25, 26, 27]);
  } finally {
    await first.close();
  }

  const gap = createArtifactPort(':memory:', makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'join', actor: 'Cara', at: 3 },
      { kind: 'say', actor: 'Cara', at: 4, body: 'gap @Alice', mentions: ['Alice'] },
      { kind: 'say', actor: 'Bob', at: 5, body: 'seen @Alice', mentions: ['Alice'] },
    ],
  }));
  try {
    const bobOnly = (await gap.transact((facts) => decideCatch(facts, 'Alice', { from: ['Bob'] }, 200))).value;
    assert.deepEqual(bobOnly.activities.map((item) => item.index), [4]);
    const repeat = (await gap.transact((facts) => decideCatch(facts, 'Alice', { from: ['Bob'] }, 201))).value;
    assert.deepEqual(repeat.activities, []);
  } finally {
    await gap.close();
  }
});
