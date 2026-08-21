import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadSquare } from '../dist/artifact.js';
import { Square, SquareError } from '../dist/index.js';

function tempSquarePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'square-behavior-')), 'SQUARE.square');
}

function tickingClock(start = 0, step = 1000) {
  let at = start;
  return {
    now: () => at,
    tick() {
      at += step;
      return at;
    },
    set(value) {
      at = value;
      return at;
    },
  };
}

async function closeSquare(square) {
  await square.close();
}

test('build persists one SQUARE01 snapshot that reopens through the facade', async () => {
  const squarePath = tempSquarePath();
  const square = await Square.build({
    path: squarePath,
    markdown: '## Topic\n\nTesting v2',
    hardCap: 3,
  });
  const snapshot = await square.snapshot();
  assert.equal(snapshot.hardCap, 3);
  assert.equal(snapshot.actCount, 0);
  assert.match(snapshot.context, /## Topic/);
  assert.match(snapshot.context, /Testing v2/);
  assert.equal(snapshot.held, null);
  await closeSquare(square);

  const bytes = fs.readFileSync(squarePath);
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'SQUARE01');
  assert.deepEqual(
    fs.readdirSync(path.dirname(squarePath)).filter((name) => name !== path.basename(squarePath) && !name.endsWith('.lock')),
    [],
  );

  const reopened = await Square.at({ path: squarePath });
  assert.equal((await reopened.snapshot()).hardCap, 3);
  assert.deepEqual((await reopened.history()).map((activity) => activity.id), []);
  await closeSquare(reopened);
});

test('build defaults to an unlimited cap and rejects a non-positive hardCap', async () => {
  const unlimited = Square.inMemory({ markdown: 'default unlimited' });
  assert.equal((await unlimited.snapshot()).hardCap, null);
  await closeSquare(unlimited);

  assert.throws(
    () => Square.inMemory({ markdown: 'removed', hardCap: -1 }),
    (error) => error instanceof SquareError && error.code === 'invalid_args' && /positive integer or null/.test(error.message),
  );
});

test('joining an unknown participant records one join activity and derives the roster', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  assert.equal(alice.name, 'Alice');
  const snapshot = await square.snapshot();
  assert.deepEqual(snapshot.participants.map((participant) => participant.name), ['Alice']);
  assert.deepEqual((await square.history()).map((activity) => ({ kind: activity.kind, actor: activity.actor })), [
    { kind: 'join', actor: 'Alice' },
  ]);
  await closeSquare(square);
});

test('rejoin does not append a second join activity', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  await square.join('Alice');
  await square.join('Alice');
  assert.deepEqual((await square.history()).map((activity) => activity.kind), ['join']);
  await closeSquare(square);
});

test('hold and resume persist the requesting actor and never a system actor', async () => {
  const time = tickingClock();
  const square = Square.inMemory({ markdown: 'context', clock: time.tick });
  const host = await square.join('Host');
  const held = await host.hold('pause');
  assert.equal(held.activity.kind, 'hold');
  assert.equal(held.activity.actor, 'Host');
  assert.equal(held.activity.body, 'pause');
  assert.equal((await square.snapshot()).held?.by, 'Host');
  const resumed = await host.resume();
  assert.equal(resumed.activity.kind, 'resume');
  assert.equal(resumed.activity.actor, 'Host');
  assert.equal((await square.snapshot()).held, null);
  assert.ok((await square.history({ all: true })).every((activity) => activity.actor !== 'system'));
  await closeSquare(square);
});

test('any self activity advances the actor cursor', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  assert.equal((await square.snapshot()).participants[0].consumedThrough, 'act/0');
  await alice.express('hello @Alice', { force: true });
  assert.equal((await square.snapshot()).participants[0].consumedThrough, 'act/1');
  await alice.done('bye');
  assert.equal((await square.snapshot()).participants[0].consumedThrough, 'act/2');
  await closeSquare(square);
});

test('catch mention returns only matching says and omits peer room changes', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await bob.express('hello @Alice', { force: true });
  await square.join('Cara');
  const caught = await alice.catch({ mention: true });
  assert.deepEqual(caught.activities.map((activity) => ({ id: activity.id, kind: activity.kind, body: activity.body })), [
    { id: 'act/2', kind: 'say', body: 'hello @Alice' },
  ]);
  assert.equal(caught.activities.some((activity) => activity.kind === 'join'), false);
  await closeSquare(square);
});

test('catch from a named peer keeps that peer\'s public acts and room changes', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const cara = await square.join('Cara');
  await bob.express('hello from bob @Alice', { force: true });
  await cara.express('hello from cara @Alice', { force: true });
  await bob.done('bye');
  const caught = await alice.catch({ from: ['Bob'] });
  assert.deepEqual(
    caught.activities.map((activity) => ({ kind: activity.kind, actor: activity.actor, body: activity.body })),
    [
      { kind: 'join', actor: 'Bob', body: undefined },
      { kind: 'say', actor: 'Bob', body: 'hello from bob @Alice' },
      { kind: 'done', actor: 'Bob', body: 'bye' },
    ],
  );
  assert.equal(caught.activities.some((activity) => activity.actor === 'Cara'), false);
  await closeSquare(square);
});

test('catch after a rejoin still includes the departure and the return', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await alice.catch();
  await bob.done('bye');
  await square.join('Bob');
  const caught = await alice.catch();
  assert.deepEqual(
    caught.activities.map((activity) => ({ kind: activity.kind, actor: activity.actor })),
    [
      { kind: 'done', actor: 'Bob' },
      { kind: 'join', actor: 'Bob' },
    ],
  );
  await closeSquare(square);
});

test('unfiltered catch includes peer room changes', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  await square.join('Bob');
  await square.join('Cara');
  const caught = await alice.catch();
  assert.deepEqual(
    caught.activities.map((activity) => ({ kind: activity.kind, actor: activity.actor })),
    [
      { kind: 'join', actor: 'Bob' },
      { kind: 'join', actor: 'Cara' },
    ],
  );
  await closeSquare(square);
});

test('catch still delivers an unreceipted mention behind a self-advanced cursor', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await alice.express('question @Bob', { force: true });
  await bob.express('answer @Alice', { force: true });
  const caught = await bob.catch();
  assert.equal(caught.activities.some((activity) => activity.body === 'question @Bob'), true);
  const again = await bob.catch();
  assert.deepEqual(again.activities, []);
  await closeSquare(square);
});

test('history from a named participant keeps that participant\'s activities', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  await square.join('Alice');
  await square.join('Bob');
  const cara = await square.join('Cara');
  await (await square.join('Bob')).express('hello from bob @Alice', { force: true });
  await cara.express('hello from cara @Alice', { force: true });
  await cara.done('later');
  const fromCara = await square.history({ from: ['Cara'], all: true });
  assert.deepEqual(
    fromCara.map((activity) => ({ kind: activity.kind, actor: activity.actor, body: activity.body })),
    [
      { kind: 'join', actor: 'Cara', body: undefined },
      { kind: 'say', actor: 'Cara', body: 'hello from cara @Alice' },
      { kind: 'done', actor: 'Cara', body: 'later' },
    ],
  );
  assert.equal(fromCara.some((activity) => activity.body === 'hello from bob @Alice'), false);
  await closeSquare(square);
});

test('a mention target perceives the full body and everyone else perceives presence', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const cara = await square.join('Cara');
  const expressed = await alice.express('secret reach phrase @Bob', { force: true });
  const bobCaught = await bob.catch();
  const bobMention = bobCaught.activities.find((activity) => activity.id === expressed.activity.id);
  assert.deepEqual(bobMention, { ...expressed.activity, perception: 'full' });
  const caraCaught = await cara.catch();
  const caraMention = caraCaught.activities.find((activity) => activity.id === expressed.activity.id);
  assert.equal(caraMention.perception, 'presence');
  assert.equal('body' in caraMention, false);
  assert.equal((await square.history({ all: true })).find((activity) => activity.id === expressed.activity.id).body, 'secret reach phrase @Bob');
  const secondExpress = await alice.express('two targets @Cara then @bob', { force: true });
  const dan = await square.join('Dan');
  const later = await dan.history({ all: true });
  const first = later.find((activity) => activity.id === expressed.activity.id);
  const second = later.find((activity) => activity.id === secondExpress.activity.id);
  assert.equal(first.perception, 'presence');
  assert.equal('body' in first, false);
  assert.equal(second.perception, 'presence');
  assert.equal('body' in second, false);
  await closeSquare(square);
});

test('history remains read-only until catch writes a delivery receipt', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const expressed = await alice.express('hello @Bob please check', { force: true });
  assert.equal((await square.snapshot()).delivered('Bob', expressed.activity.id), false);
  await bob.history({ all: true });
  await square.history({ grep: 'please check' });
  assert.equal((await square.snapshot()).delivered('Bob', expressed.activity.id), false);
  const caught = await bob.catch();
  assert.equal(caught.activities[0].body, 'hello @Bob please check');
  assert.equal((await square.snapshot()).delivered('Bob', expressed.activity.id), true);
  assert.deepEqual((await bob.catch()).activities, []);
  await closeSquare(square);
});

test('history grep searches ids, participant names, and bodies and honors limit order', async () => {
  const square = Square.inMemory({ markdown: 'context', hardCap: null, clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await alice.express('first inventory @Bob', { force: true });
  await bob.express('facts only @Alice', { force: true });
  assert.equal((await square.history({ grep: '^act/2$' }))[0].body, 'first inventory @Bob');
  assert.equal((await square.history({ grep: '^Bob$' }))[0].body, 'facts only @Alice');
  assert.deepEqual(
    (await square.history({ grep: 'act/2|facts only', limit: 2 })).map((activity) => activity.id),
    ['act/2', 'act/3'],
  );
  for (let index = 0; index < 12; index += 1) {
    await alice.express(`needle ${index} @Alice`, { force: true });
  }
  assert.deepEqual(
    (await square.history({ grep: 'needle', limit: 3 })).map((activity) => activity.body),
    ['needle 9 @Alice', 'needle 10 @Alice', 'needle 11 @Alice'],
  );
  assert.deepEqual(
    (await square.history({ grep: 'needle', limit: 3, order: 'desc' })).map((activity) => activity.body),
    ['needle 11 @Alice', 'needle 10 @Alice', 'needle 9 @Alice'],
  );
  await closeSquare(square);
});

test('an unread directed body is not leaked when express is blocked', async () => {
  const time = tickingClock();
  const square = Square.inMemory({ markdown: 'context', clock: time.now });
  time.set(1000);
  const alice = await square.join('Alice');
  time.set(2000);
  await square.join('Bob');
  time.set(3000);
  const cara = await square.join('Cara');
  time.set(4000);
  await alice.express('secret pending phrase @Bob', { force: true });
  time.set(100000);
  await assert.rejects(
    () => cara.express('cara tries after unread @Alice'),
    (error) => error instanceof SquareError && error.code === 'behind' && !String(error.message).includes('secret pending phrase'),
  );
  await closeSquare(square);
});

test('a bell pierces catch filters and a second bell inside the hour is refused', async () => {
  const time = tickingClock();
  const square = Square.inMemory({ markdown: 'context', clock: time.now });
  time.set(1000);
  const alice = await square.join('Alice');
  time.set(2000);
  const bob = await square.join('Bob');
  time.set(3000);
  const cara = await square.join('Cara');
  time.set(4000);
  const bell = await alice.express('bell one', { force: true, reach: 'bell' });
  const mentionWatch = await cara.catch({ mention: true });
  assert.equal(mentionWatch.activities.some((activity) => activity.body === 'bell one'), true);
  const fromWatch = await bob.catch({ from: ['Cara'] });
  assert.equal(fromWatch.activities.some((activity) => activity.id === bell.activity.id), true);
  assert.equal((await square.history({ from: ['Cara'], all: true })).some((activity) => activity.body === 'bell one'), false);
  time.set(7000);
  await assert.rejects(
    () => alice.express('bell two', { reach: 'bell' }),
    (error) => error instanceof SquareError && error.code === 'bell_quota' && error.facts?.retryAfterMs > 0,
  );
  await closeSquare(square);
});

test('stored say omits mention reach while bell persists explicitly', async () => {
  const squarePath = tempSquarePath();
  const time = tickingClock();
  const square = await Square.build({ path: squarePath, markdown: 'context', clock: time.tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await alice.express('mention @Bob', { force: true });
  await bob.express('bell line', { force: true, reach: 'bell' });
  await closeSquare(square);
  const persisted = loadSquare(squarePath);
  assert.equal(persisted.acts[2].reach, undefined);
  assert.equal(persisted.acts[3].reach, 'bell');
  assert.doesNotMatch(JSON.stringify(persisted), /beside/);
});

test('express reply preserves one causal activity reference', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const question = await alice.express('question @Bob', { force: true });
  const replied = await bob.express('answer @Alice', { force: true, reply: question.activity.id });
  assert.equal(replied.activity.reply, question.activity.id);
  await assert.rejects(
    () => bob.express('orphan @Alice', { force: true, reply: 'act/99' }),
    (error) => error instanceof SquareError && error.code === 'invalid_args' && /Unknown reply activity: act\/99/.test(error.message),
  );
  await closeSquare(square);
});

test('snapshot counts only people still in the square and tracks done participants', async () => {
  const square = Square.inMemory({ markdown: 'context', hardCap: 100, clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  for (let index = 0; index < 12; index += 1) {
    await alice.express(`activity ${index} @Bob`, { force: true });
  }
  await bob.done('leaving');
  await alice.express('last activity @Alice', { force: true });
  const snapshot = await square.snapshot();
  assert.equal(snapshot.hardCap, 100);
  assert.equal(snapshot.participants.filter((participant) => participant.state === 'joined').length, 1);
  assert.equal(snapshot.participants.filter((participant) => participant.state === 'done').length, 1);
  assert.equal(snapshot.participants.find((participant) => participant.name === 'Alice').state, 'joined');
  assert.equal(snapshot.participants.find((participant) => participant.name === 'Bob').state, 'done');
  await closeSquare(square);
});

test('room changes and a final note land once through catch', async () => {
  const square = Square.inMemory({ markdown: 'context', clock: tickingClock().tick });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await bob.hold('pause');
  await bob.resume();
  const first = await alice.catch();
  assert.deepEqual(
    first.activities.map((activity) => ({ kind: activity.kind, actor: activity.actor, body: activity.body })),
    [
      { kind: 'join', actor: 'Bob', body: undefined },
      { kind: 'hold', actor: 'Bob', body: 'pause' },
      { kind: 'resume', actor: 'Bob', body: undefined },
    ],
  );
  await bob.done('final note');
  const afterDone = await alice.catch();
  assert.deepEqual(
    afterDone.activities.map((activity) => ({ kind: activity.kind, body: activity.body })),
    [{ kind: 'done', body: 'final note' }],
  );
  assert.equal((await square.history({ all: true })).filter((activity) => activity.body === 'final note').length, 1);
  await closeSquare(square);
});

test('hold, unread room changes, and an unread join gate express independently', async () => {
  const time = tickingClock();
  const square = Square.inMemory({ markdown: 'context', clock: time.now });
  time.set(1000);
  const alice = await square.join('Alice');
  time.set(2000);
  const bob = await square.join('Bob');
  time.set(3000);
  await bob.hold('pause');
  time.set(200000);
  await assert.rejects(
    () => alice.express('late body @Bob'),
    (error) => error instanceof SquareError && error.code === 'held' && error.facts?.holder === 'Bob',
  );
  time.set(210000);
  await bob.resume();
  time.set(220000);
  await assert.rejects(
    () => alice.express('after resume @Bob'),
    (error) => error instanceof SquareError && error.code === 'behind',
  );

  const open = Square.inMemory({ markdown: 'context', clock: time.now });
  time.set(1000);
  const welcomeAlice = await open.join('Alice');
  time.set(2000);
  await open.join('Bob');
  time.set(200000);
  const welcomed = await welcomeAlice.express('welcome @Bob');
  assert.equal(welcomed.activity.body, 'welcome @Bob');
  await closeSquare(square);
  await closeSquare(open);
});

test('held, throttled, and capped expressions keep their coded errors', async () => {
  const heldSquare = Square.inMemory({ markdown: 'context', hardCap: 10, clock: tickingClock().tick });
  const heldAlice = await heldSquare.join('Alice');
  const host = await heldSquare.join('Host');
  await host.hold('pause');
  await assert.rejects(
    () => heldAlice.express('held body @Host'),
    (error) => error instanceof SquareError && error.code === 'held',
  );
  await closeSquare(heldSquare);

  const throttleSquare = Square.inMemory({
    markdown: 'context',
    hardCap: 10,
    throttlePerMinute: 1,
    clock: tickingClock().tick,
  });
  const throttleAlice = await throttleSquare.join('Alice');
  await throttleAlice.express('first @Alice', { force: true });
  await assert.rejects(
    () => throttleAlice.express('throttled body @Alice'),
    (error) => error instanceof SquareError && error.code === 'throttled' && error.facts?.retryAfterMs > 0,
  );
  await closeSquare(throttleSquare);

  const capSquare = Square.inMemory({ markdown: 'context', hardCap: 1, clock: tickingClock().tick });
  const capAlice = await capSquare.join('Alice');
  await capAlice.express('first @Alice', { force: true });
  await assert.rejects(
    () => capAlice.express('final body @Alice'),
    (error) => error instanceof SquareError && error.code === 'capped',
  );
  await closeSquare(capSquare);
});
