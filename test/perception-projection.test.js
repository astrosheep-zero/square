import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyRuntimeState } from '../dist/artifact.js';
import { decideCatch } from '../dist/catch-decisions.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { derivePerceptionProjection } from '../dist/perception-projection.js';

function squareState(acts, runtime = emptyRuntimeState(acts.length)) {
  return {
    hardCap: null,
    preamble: [],
    warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { ...runtime, nextActIndex: acts.length },
  };
}

test('catch and delivery share one perception projection across case and rejoin boundaries', () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'first @BOB', mentions: ['BOB'] },
    { kind: 'done', actor: 'Bob', at: 4 },
    { kind: 'join', actor: 'bob', at: 5 },
    { kind: 'say', actor: 'Alice', at: 6, body: 'second @bob', mentions: ['bob'] },
  ];
  const state = squareState(acts);
  const perception = derivePerceptionProjection(state);
  const delivery = deriveDeliveryModel(state);

  assert.equal(perception.replayedActivityCount, acts.length);
  assert.equal(delivery.replayedActivityCount, acts.length);
  for (const activity of state.acts) {
    assert.equal(delivery.directedTo(activity, 'BOB'), perception.directedTo(activity, 'BOB'));
    assert.equal(delivery.perceive(activity, 'BOB'), perception.perceive(activity, 'BOB'));
  }
  assert.equal(delivery.cursorFor('BOB'), perception.cursorFor('BOB'));
  assert.equal(delivery.isSeen('BOB', 2), perception.isSeen('BOB', 2));

  const caught = decideCatch(state, 'BOB', {} , 10);
  assert.deepEqual(caught.delivered.map((activity) => activity.index), [2, 5]);
  assert.equal(caught.perceptions.get(2), 'full');
  assert.equal(caught.perceptions.get(5), 'full');
});

test('seen observations stay dynamic while cursor follows the continuous seen prefix', () => {
  const state = squareState([
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'one @Bob', mentions: ['Bob'] },
    { kind: 'say', actor: 'Alice', at: 4, body: 'two @Bob', mentions: ['Bob'] },
  ]);
  const perception = derivePerceptionProjection(state);

  assert.equal(perception.isSeen('bob', 2), false);
  assert.equal(perception.cursorFor('bob'), 1);
  state.runtime.observations.Bob = { 'act/2': { state: 'seen', at: 10 } };
  assert.equal(perception.isSeen('BOB', 2), true);
  assert.equal(perception.cursorFor('BOB'), 2);
});
