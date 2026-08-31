import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyRuntimeState } from '../dist/artifact.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { pendingNotificationSweepFromState } from '../dist/notifications.js';
import { catchUp } from '../dist/presence.js';
import { renderWatchOutput } from '../dist/presentation.js';
import { createMemoryCell } from '../dist/square-storage.js';
import { pendingDeliveries } from '../dist/views.js';

function squareState(acts) {
  return {
    hardCap: null,
    preamble: [],
    warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: emptyRuntimeState(acts.length),
  };
}

test('large catch and pending sweep share one chronological delivery replay per snapshot', async () => {
  const acts = [{ kind: 'join', actor: 'Alice', at: 0 }];
  for (let index = 0; index < 96; index++) acts.push({ kind: 'join', actor: `P${index}`, at: index + 1 });
  for (let index = 0; index < 900; index++) {
    acts.push({ kind: 'say', actor: 'Alice', at: index + 100, body: `dispatch ${index} @P0`, mentions: ['P0'] });
  }

  const state = squareState(acts);
  const delivery = deriveDeliveryModel(state);
  assert.equal(delivery.replayedActivityCount, state.acts.length);
  for (const recipient of delivery.joinedRecipients()) delivery.pendingFor(recipient);
  assert.equal(delivery.replayedActivityCount, state.acts.length);

  const cell = createMemoryCell(squareState(acts));
  const square = { artifact: cell, clock: () => 2_000, location: 'memory' };
  try {
    const caught = await catchUp(square, 'P0');
    assert.equal(caught.activities.length, 10);
    assert.equal(caught.remaining, 890);
    const pending = await pendingDeliveries(square);
    assert.equal(pending.length, 97);
    assert.equal(pending.find((item) => item.recipient === 'P0')?.notifications.length, 890);
  } finally {
    await cell.close();
  }
});

test('large frozen wake sweep uses one delivery replay across every pending candidate', async () => {
  const acts = [{ kind: 'join', actor: 'Alice', at: 0 }];
  for (let index = 0; index < 96; index++) acts.push({ kind: 'join', actor: `P${index}`, at: index + 1 });
  for (let index = 0; index < 900; index++) {
    acts.push({ kind: 'say', actor: 'Alice', at: index + 100, body: `dispatch ${index} @P0`, mentions: ['P0'] });
  }

  const state = squareState(acts);
  let derivations = 0;

  const selected = await pendingNotificationSweepFromState('memory-square', state, 100_000, {
    ...process.env,
    SQUARE_NOTIFY_DELIVERY_WAIT_MS: '1',
  }, 1_000, (snapshot) => {
    derivations += 1;
    return deriveDeliveryModel(snapshot);
  });

  assert.deepEqual(selected, []);
  assert.equal(derivations, 1);
});

test('large delivered catch carries its settled perception into rendering without another delivery replay', async () => {
  const acts = [{ kind: 'join', actor: 'Alice', at: 0 }];
  acts.push({ kind: 'join', actor: 'P0', at: 1 });
  for (let index = 0; index < 900; index++) {
    acts.push({ kind: 'say', actor: 'Alice', at: index + 2, body: `dispatch ${index} @P0`, mentions: ['P0'] });
  }

  const state = squareState(acts);
  const cell = createMemoryCell(state);
  const square = { cell, clock: () => 100_000, location: 'memory' };
  let derivations = 0;
  try {
    const caught = await catchUp(square, 'P0', {}, (snapshot) => {
      derivations += 1;
      return deriveDeliveryModel(snapshot);
    });
    const perceptions = new Map(caught.activities.map((activity) => [Number(activity.id.slice(4)), activity.perception]));
    const publicItems = state.acts.filter((activity) => perceptions.has(activity.index) && (activity.kind === 'say' || activity.kind === 'done'));

    const output = renderWatchOutput(state.acts, publicItems, [], {
      squarePath: 'memory-square',
      viewer: 'P0',
      perceptions,
    });

    assert.match(output, /dispatch 0 @P0/);
    assert.doesNotMatch(output, /dispatch 899 @P0/);
    assert.equal(caught.activities.length, 10);
    assert.equal(caught.remaining, 890);
    assert.equal(derivations, 1);
  } finally {
    await cell.close();
  }
});
