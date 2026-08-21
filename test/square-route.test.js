import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureRoute, express, Square } from '../dist/index.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { loadSquare } from '../dist/artifact.js';
import { recordJoin } from '../dist/registry.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-route-'));
  const squarePath = path.join(root, '.square', 'PUBLIC.square');
  const registry = path.join(root, 'sessions.ndjsonl');
  const previousRegistry = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registry;
  return {
    root,
    squarePath,
    restore() {
      if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
      else process.env.SQUARE_REGISTRY = previousRegistry;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('captureRoute serializes the exact public route shape', async () => {
  const item = fixture();
  try {
    const square = await Square.build({ path: item.squarePath, markdown: 'context', clock: () => 10 });
    await square.join('Bob');
    await square.close();
    recordJoin('bob-session', 'Bob', item.squarePath, { channel: 'codex' });

    const route = captureRoute({ cwd: item.root, env: { CODEX_THREAD_ID: 'bob-session' } });
    assert.deepEqual(JSON.parse(JSON.stringify(route)), { v: 1, squarePath: fs.realpathSync(item.squarePath), name: 'Bob' });
    assert.deepEqual(Object.keys(route).sort(), ['name', 'squarePath', 'v']);
  } finally {
    item.restore();
  }
});

test('route express uses the caller sender and appends the captured recipient mention', async () => {
  const item = fixture();
  try {
    const square = await Square.build({ path: item.squarePath, markdown: 'context', clock: () => 20 });
    await square.join('Bob');
    await square.close();
    recordJoin('bob-session', 'Bob', item.squarePath, { channel: 'codex' });
    const route = captureRoute({ cwd: item.root, env: { CODEX_THREAD_ID: 'bob-session' } });

    const result = await express(route, { as: 'Alice', body: 'hello from the caller' });
    assert.equal(result.activity.actor, 'Alice');
    assert.equal(result.activity.body, 'hello from the caller @Bob');
    assert.deepEqual(result.activity.mentions, ['Bob']);
  } finally {
    item.restore();
  }
});

test('route express durably lands public activity for an offline recipient and leaves pending attention', async () => {
  const item = fixture();
  try {
    const square = await Square.build({ path: item.squarePath, markdown: 'context', clock: () => 30 });
    await square.join('Bob');
    await square.close();
    recordJoin('bob-session', 'Bob', item.squarePath, { channel: 'codex' });
    const route = captureRoute({ cwd: item.root, env: { CODEX_THREAD_ID: 'bob-session' } });

    await express(route, { as: 'Alice', body: 'offline note' });
    const persisted = loadSquare(item.squarePath);
    const activity = persisted.acts.find((act) => act.kind === 'say');
    assert.deepEqual(activity && { actor: activity.actor, body: activity.body }, { actor: 'Alice', body: 'offline note @Bob' });
    assert.equal(fs.existsSync(item.squarePath), true);
    assert.deepEqual(deriveDeliveryModel(persisted).pendingFor('Bob').map(({ item: pending }) => pending.index), [activity.index]);

    const reopened = await Square.at({ path: item.squarePath, clock: () => 40 });
    const bob = await reopened.join('Bob');
    const caught = await bob.catch();
    const caughtSay = caught.activities.find((activity) => activity.kind === 'say');
    assert.equal(caughtSay?.body, 'offline note @Bob');
    assert.deepEqual(deriveDeliveryModel(loadSquare(item.squarePath)).pendingFor('Bob'), []);
    await reopened.close();
  } finally {
    item.restore();
  }
});
