import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { emptyRuntimeState, renderSquareDoc, saveRuntimeSidecar } from '../dist/artifact.js';
import { classifyDeliveryHealth, doctorDeliveryHealth } from '../dist/delivery-health.js';
import { hasAttentionNotification } from '../dist/notifications.js';
import { presentOnce } from '../dist/presented.js';
import { recordJoin } from '../dist/registry.js';
import { upsertWakeRoute } from '../dist/routes.js';
import { recordWakeAttempt } from '../dist/wake-attempts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-delivery-health-'));
  const squarePath = path.join(root, 'square.md');
  const now = Date.now();
  const env = {
    SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'),
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'),
  };
  const recipients = ['Bob', 'Cara', 'Dana', 'Eli', 'Faye', 'Gina'];
  const acts = [
    { kind: 'join', actor: 'Alice', at: now - 180_000, body: '' },
    ...recipients.map((actor, index) => ({ kind: 'join', actor, at: now - 170_000 + index, body: '' })),
    ...recipients.map((recipient, index) => ({
      kind: 'say',
      actor: 'Alice',
      at: now - 120_000 + index,
      body: `attention @${recipient}`,
    })),
  ].map((act, index) => ({ ...act, index }));
  const runtime = emptyRuntimeState(acts.length);
  runtime.deliveryReceipts.Gina = { [`act_${acts.length - 1}`]: { status: 'delivered', at: now - 100 } };
  fs.writeFileSync(squarePath, renderSquareDoc({ hardCap: null, preamble: [], warmup: ['w'], acts, runtime }));
  saveRuntimeSidecar(squarePath, runtime);
  return { root, squarePath, env, acts, now };
}

function withRegistry(env, fn) {
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = env.SQUARE_REGISTRY;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
  }
}

function actFor(item, recipient) {
  return item.acts.find((act) => act.kind === 'say' && act.body.endsWith(`@${recipient}`));
}

function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root).sort().map((name) => {
    const file = path.join(root, name);
    return [name, fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : '<directory>'];
  }));
}

test('doctor is a pure classification of current primary evidence', () => {
  const item = fixture();
  const bob = actFor(item, 'Bob');
  const cara = actFor(item, 'Cara');
  const dana = actFor(item, 'Dana');

  withRegistry(item.env, () => {
    recordJoin('bob-session', 'Bob', item.squarePath, { ownerId: 'bob-owner', at: item.now - 5_000 });
    presentOnce('bob-session', () => [{
      name: 'Bob',
      squarePath: item.squarePath,
      notifications: [{ actIndex: bob.index, actor: 'Alice', at: bob.at, route: 'mention', body: bob.body }],
    }], () => true, item.env, item.now - 4_000);
    recordJoin('faye-session', 'Faye', item.squarePath, { ownerId: 'faye-owner', at: item.now - 3_000 });
  });
  upsertWakeRoute({
    ownerId: 'faye-owner',
    sessionId: 'faye-agent',
    kind: 'paseo',
    address: { agentId: 'faye-agent' },
    source: 'join-env',
  }, { env: item.env, at: item.now - 2_000 });
  recordWakeAttempt({
    attention: { squarePath: item.squarePath, actIndex: cara.index, recipient: 'Cara' },
    routeKind: 'paseo', outcome: 'accepted', attemptN: 1, at: item.now - 1_500,
  }, item.env);
  recordWakeAttempt({
    attention: { squarePath: item.squarePath, actIndex: dana.index, recipient: 'Dana' },
    routeKind: 'paseo', outcome: 'unknown', signature: 'send_unknown', attemptN: 1, at: item.now - 1_000,
  }, item.env);

  const before = snapshot(item.root);
  const first = withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, { now: item.now, env: item.env }));
  const second = withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, { now: item.now, env: item.env }));
  const output = withRegistry(item.env, () => doctorDeliveryHealth(item.squarePath, item.now, item.env)).join('\n');

  assert.deepEqual(second, first);
  assert.deepEqual(first.map(({ recipient, kind }) => [recipient, kind]), [
    ['Bob', 'presented-not-delivered'],
    ['Cara', 'wake-accepted'],
    ['Dana', 'wake-unknown'],
    ['Eli', 'unreachable'],
    ['Faye', 'awaiting'],
  ]);
  assert.equal(first.some(({ recipient }) => recipient === 'Gina'), false);
  assert.match(output, /○ wake-accepted: 1/);
  assert.match(output, /✕ wake-unknown: 1/);
  assert.match(output, /✕ unreachable: 1/);
  assert.deepEqual(snapshot(item.root), before);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('presentation suppresses wake and affects doctor only for the current owner', () => {
  const item = fixture();
  const bob = actFor(item, 'Bob');

  withRegistry(item.env, () => {
    recordJoin('old-session', 'Bob', item.squarePath, { ownerId: 'old-owner', at: item.now - 5_000 });
    presentOnce('old-session', () => [{
      name: 'Bob',
      squarePath: item.squarePath,
      notifications: [{ actIndex: bob.index, actor: 'Alice', at: bob.at, route: 'mention', body: bob.body }],
    }], () => true, item.env, item.now - 4_000);
    recordJoin('new-session', 'Bob', item.squarePath, { ownerId: 'new-owner', at: item.now - 3_000 });
  });
  upsertWakeRoute({
    ownerId: 'new-owner',
    sessionId: 'new-agent',
    kind: 'paseo',
    address: { agentId: 'new-agent' },
    source: 'join-env',
  }, { env: item.env, at: item.now - 2_000 });

  const suppressed = withRegistry(item.env, () => hasAttentionNotification(
    item.squarePath, 'Bob', bob.index, item.env,
  ));
  const bobHealth = withRegistry(item.env, () => classifyDeliveryHealth(
    item.squarePath, { now: item.now, env: item.env },
  )).find(({ recipient }) => recipient === 'Bob');

  assert.equal(suppressed, false);
  assert.equal(bobHealth.kind, 'awaiting');
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('delivery evidence writers and health labels stay inside their owning modules', () => {
  const sources = fs.readdirSync(ROOT)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [name, fs.readFileSync(path.join(ROOT, name), 'utf8')]);
  const externalUsers = (symbol, owner) => sources
    .filter(([name, source]) => name !== owner && source.includes(`${symbol}(`))
    .map(([name]) => name)
    .sort();

  assert.deepEqual(externalUsers('presentOnce', 'presented.ts'), ['boundary-presentation.ts']);
  assert.deepEqual(externalUsers('markDeliveredNotifications', 'delivery.ts'), ['watch.ts']);
  assert.deepEqual(externalUsers('recordWakeAttempt', 'wake-attempts.ts'), ['notifications.ts']);
  assert.deepEqual(externalUsers('recordRecoveredUnknown', 'wake-attempts.ts'), ['notifications.ts']);

  const labels = ['wake-accepted', 'wake-unknown', 'presented-not-delivered', 'unreachable'];
  for (const [name, source] of sources) {
    if (name === 'delivery-health.ts') continue;
    for (const label of labels) assert.equal(source.includes(label), false, `${label} leaked into ${name}`);
  }
  for (const name of ['notifications.ts', 'routes.ts', 'wake-attempts.ts', 'wake-port.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, name), 'utf8'), /delivery-health/);
  }
});
