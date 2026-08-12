import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { renderSquareDoc, emptyRuntimeState, saveRuntimeSidecar } from '../dist/artifact.js';
import { recordJoin } from '../dist/registry.js';
import {
  dispatchActNotifications,
  matchesMentionTarget,
  planActNotifications,
  processActNotificationsOnce,
} from '../dist/notifications.js';
import { readNotificationFailures, recordNotificationFailure } from '../dist/notification-failures.js';
import { discoverPaseoAgents } from '../dist/paseo-state.js';
import { dispatchPaseoNotification, PaseoWakeError } from '../dist/paseo-delivery.js';
import { presentOnce } from '../dist/presented.js';

function tempSquare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-notify-'));
  return path.join(dir, 'square.md');
}

function writeDoc(file, overrides = {}) {
  const acts = (overrides.acts ?? []).map((act, index) => ({ ...act, index }));
  const doc = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts,
    runtime: overrides.runtime ?? { ...emptyRuntimeState(acts.length), nextActIndex: acts.length },
  };
  fs.writeFileSync(file, renderSquareDoc(doc));
  saveRuntimeSidecar(file, doc.runtime);
  return doc;
}

test('Paseo discovery fails promptly when the daemon command hangs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-paseo-timeout-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const paseo = path.join(bin, 'paseo');
  fs.writeFileSync(paseo, '#!/bin/sh\nsleep 2\n');
  fs.chmodSync(paseo, 0o755);
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { discoverPaseoAgents } from './dist/paseo-state.js'; console.log(JSON.stringify(discoverPaseoAgents(20)));",
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.deepEqual(result.agents, []);
  assert.match(result.error, /ETIMEDOUT|timed out/i);
});

test('Paseo discovery always uses the global agent inventory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-paseo-global-'));
  const paseo = path.join(dir, 'paseo');
  const log = path.join(dir, 'args.log');
  fs.writeFileSync(
    paseo,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$SQUARE_FAKE_PASEO_LOG"\nprintf '%s\\n' '[]'\n`
  );
  fs.chmodSync(paseo, 0o755);
  const previousBin = process.env.SQUARE_PASEO_BIN;
  const previousLog = process.env.SQUARE_FAKE_PASEO_LOG;
  process.env.SQUARE_PASEO_BIN = paseo;
  process.env.SQUARE_FAKE_PASEO_LOG = log;
  try {
    assert.deepEqual(discoverPaseoAgents().agents, []);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['ls', '--global', '--json']);
  } finally {
    if (previousBin === undefined) delete process.env.SQUARE_PASEO_BIN;
    else process.env.SQUARE_PASEO_BIN = previousBin;
    if (previousLog === undefined) delete process.env.SQUARE_FAKE_PASEO_LOG;
    else process.env.SQUARE_FAKE_PASEO_LOG = previousLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matchesMentionTarget keeps broadcast semantics for say acts', () => {
  assert.equal(matchesMentionTarget({ body: 'ping @Alice' }, 'alice'), true);
  assert.equal(matchesMentionTarget({ body: 'broadcast update' }, 'Alice'), true);
  assert.equal(matchesMentionTarget({ body: 'ping @Bob' }, 'Alice'), false);
  assert.equal(matchesMentionTarget({ body: 'ping @Bob' }, true), true);
  assert.equal(matchesMentionTarget({ body: 'private update', reach: { beside: 'Bob' } }, 'Bob'), true);
  assert.equal(matchesMentionTarget({ body: 'private update', reach: { beside: 'Bob' } }, 'Cara'), false);
});

test('notifications only plan and dispatch for say acts', async () => {
  const file = tempSquare();
  const doc = writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
      { kind: 'done', actor: 'Alice', at: 4, body: 'bye' },
    ],
  });

  assert.deepEqual(planActNotifications(doc, doc.acts[0]), []);
  assert.deepEqual(planActNotifications(doc, doc.acts[3]), []);
  assert.deepEqual(
    planActNotifications(doc, doc.acts[2]).map((item) => [item.recipient, item.route]),
    [['Bob', 'mention']]
  );

  let launched = false;
  await dispatchActNotifications(file, doc.acts[3], {
    launchWorker() { launched = true; },
  });
  assert.equal(launched, false);
});

test('beside and bell notifications keep distinct delivery routes', () => {
  const file = tempSquare();
  const doc = writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'join', actor: 'Cara', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'private aside', reach: { beside: 'Bob' } },
      { kind: 'say', actor: 'Alice', at: 5, body: 'hear this', reach: 'bell' },
    ],
  });

  assert.deepEqual(
    planActNotifications(doc, doc.acts[3]).map((item) => [item.recipient, item.route]),
    [['Bob', 'beside']]
  );
  assert.deepEqual(
    planActNotifications(doc, doc.acts[4]).map((item) => [item.recipient, item.route]),
    [
      ['Bob', 'bell'],
      ['Cara', 'bell'],
    ]
  );
});

test('notifications do not wake a participant who has stepped out', async () => {
  const file = tempSquare();
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'done', actor: 'Bob', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'hey @Bob' },
    ],
  });
  const dispatched = [];
  await processActNotificationsOnce(file, 3, {
    sinks: [{ name: 'test', async dispatch(notification) { dispatched.push(notification.recipient); } }],
  });
  assert.deepEqual(dispatched, []);
});

test('act receipt ids use act_ keys', async () => {
  const file = tempSquare();
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
    runtime: {
      version: 2,
      nextActIndex: 3,
      cursors: {},
      deliveryReceipts: { Bob: { act_2: { status: 'delivered', at: 4 } } },
      leases: {},
    },
  });

  const dispatched = [];
  await processActNotificationsOnce(file, 2, {
    sinks: [{ name: 'test', async dispatch(notification) { dispatched.push(notification.recipient); } }],
  });
  assert.deepEqual(dispatched, []);
});

test('notification failures stay pending and remain diagnosable after a later wake succeeds', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  const failures = path.join(root, 'notification-failures.ndjsonl');
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  const previous = process.env.SQUARE_NOTIFICATION_FAILURES;
  process.env.SQUARE_NOTIFICATION_FAILURES = failures;
  try {
    await processActNotificationsOnce(file, 2, {
      sinks: [{ name: 'paseo', async dispatch() {
        throw new PaseoWakeError('Paseo unavailable: auth_required', {
          phase: 'discovery',
          code: 'unavailable',
          command: 'paseo ls --json',
          endpoint: '100.126.66.71:6767',
          paseoAgentIds: ['agent-root'],
          ownerIds: ['owner-root'],
          passwordPresent: false,
        });
      } }],
    });
    assert.deepEqual(readNotificationFailures(file), [{
      actIndex: 2,
      recipient: 'Bob',
      route: 'mention',
      sink: 'paseo',
      message: 'Paseo unavailable: auth_required',
      at: readNotificationFailures(file)[0].at,
      diagnostic: {
        phase: 'discovery',
        code: 'unavailable',
        command: 'paseo ls --json',
        endpoint: '100.126.66.71:6767',
        paseoAgentIds: ['agent-root'],
        ownerIds: ['owner-root'],
        passwordPresent: false,
      },
    }]);

    await processActNotificationsOnce(file, 2, {
      sinks: [{ name: 'paseo', async dispatch() {} }],
    });
    assert.equal(readNotificationFailures(file).length, 1);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_NOTIFICATION_FAILURES;
    else process.env.SQUARE_NOTIFICATION_FAILURES = previous;
  }
});

test('notification failure ledger redacts the configured Paseo password', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  const failures = path.join(root, 'notification-failures.ndjsonl');
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  const previousFailures = process.env.SQUARE_NOTIFICATION_FAILURES;
  const previousPassword = process.env.PASEO_PASSWORD;
  process.env.SQUARE_NOTIFICATION_FAILURES = failures;
  process.env.PASEO_PASSWORD = 'never-write-this-secret';
  try {
    await processActNotificationsOnce(file, 2, {
      sinks: [{ name: 'paseo', async dispatch() {
        throw new Error('Paseo rejected never-write-this-secret');
      } }],
    });
    const text = fs.readFileSync(failures, 'utf8');
    assert.doesNotMatch(text, /never-write-this-secret/);
    assert.match(text, /\[redacted\]/);
  } finally {
    if (previousFailures === undefined) delete process.env.SQUARE_NOTIFICATION_FAILURES;
    else process.env.SQUARE_NOTIFICATION_FAILURES = previousFailures;
    if (previousPassword === undefined) delete process.env.PASEO_PASSWORD;
    else process.env.PASEO_PASSWORD = previousPassword;
  }
});

test('detached notification worker records an uncaught worker failure', () => {
  const file = tempSquare();
  const failures = path.join(path.dirname(file), 'notification-failures.ndjsonl');
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  const worker = path.resolve(import.meta.dirname, '../dist/cmd/notify-once.js');
  const result = spawnSync(process.execPath, [worker, '--square-path', file, '--act-index', '2'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SQUARE_DISABLE_PASEO_WAKE: '0',
      SQUARE_NOTIFY_DELIVERY_WAIT_MS: 'not-a-number',
      SQUARE_NOTIFICATION_FAILURES: failures,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = readNotificationFailures(file, { SQUARE_NOTIFICATION_FAILURES: failures });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sink, 'worker');
  assert.equal(rows[0].recipient, undefined);
  assert.equal(rows[0].diagnostic?.phase, 'worker');
  assert.match(rows[0].message, /SQUARE_NOTIFY_DELIVERY_WAIT_MS/);
});

test('notification failure ledger compacts old events before appending', () => {
  const file = tempSquare();
  const failures = path.join(path.dirname(file), 'notification-failures.ndjsonl');
  const rows = Array.from({ length: 2_200 }, (_, index) => JSON.stringify({
    v: 1,
    op: 'failed',
    actIndex: index,
    recipient: 'Bob',
    route: 'mention',
    sink: 'paseo',
    message: 'x'.repeat(600),
    at: index + 1,
  }));
  fs.writeFileSync(failures, `${rows.join('\n')}\n`);
  recordNotificationFailure(file, {
    actIndex: 2_200,
    recipient: 'Bob',
    route: 'mention',
    sink: 'paseo',
    message: 'latest',
  }, 2_201, { SQUARE_NOTIFICATION_FAILURES: failures });
  const retained = readNotificationFailures(file, { SQUARE_NOTIFICATION_FAILURES: failures });
  assert.ok(retained.length < 2_200);
  assert.equal(retained.at(-1)?.actIndex, 2_200);
  assert.ok(fs.statSync(failures).size < 1024 * 1024 + 1_000);
});

test('mention dispatch launches one detached worker and the worker routes unread recipients', async () => {
  const file = tempSquare();
  const doc = writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  let launched;
  await dispatchActNotifications(file, doc.acts[2], {
    launchWorker(workerPath, args) { launched = { workerPath, args }; },
  });
  assert.match(launched.workerPath, /cmd[/\\]notify-once\.js$/);
  assert.deepEqual(launched.args, ['--square-path', file, '--act-index', '2']);

  const dispatched = [];
  await processActNotificationsOnce(file, 2, {
    sinks: [{ name: 'test', async dispatch(notification, context) {
      dispatched.push([notification.recipient, context.squarePath]);
    } }],
  });
  assert.deepEqual(dispatched, [['Bob', file]]);
});

test('notification recipients dispatch independently', async () => {
  const file = tempSquare();
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'join', actor: 'Cara', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'attention', reach: 'bell' },
    ],
  });
  const started = [];
  const releases = [];
  const processing = processActNotificationsOnce(file, 3, {
    sinks: [{ name: 'test', dispatch(notification) {
      started.push(notification.recipient);
      return new Promise((resolve) => releases.push(resolve));
    } }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['Bob', 'Cara']);
  for (const release of releases) release();
  await processing;
});

test('only retryable wake failures back off, and attention is rechecked before retry', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  const previousRegistry = process.env.SQUARE_REGISTRY;
  const previousPresented = process.env.SQUARE_PRESENTED;
  process.env.SQUARE_REGISTRY = registry;
  process.env.SQUARE_PRESENTED = presented;
  try {
    recordJoin('bob-session', 'Bob', file, { channel: 'codex', ownerId: 'bob-owner' });
    let attempts = 0;
    const delays = [];
    await processActNotificationsOnce(file, 2, {
      retryDelaysMs: [10, 20],
      delay: async (ms) => {
        delays.push(ms);
        presentOnce('bob-session', () => [{
          name: 'Bob',
          squarePath: file,
          notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'hey @Bob' }],
        }], () => true);
      },
      sinks: [{ name: 'test', async dispatch() {
        attempts++;
        throw new PaseoWakeError('pre-accept failure', undefined, true);
      } }],
    });
    assert.equal(attempts, 1);
    assert.deepEqual(delays, [10]);
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    if (previousPresented === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previousPresented;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown wake failures are never retried', async () => {
  const file = tempSquare();
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  let attempts = 0;
  await processActNotificationsOnce(file, 2, {
    retryDelaysMs: [1, 1],
    delay: async () => { throw new Error('unknown failure must not sleep'); },
    sinks: [{ name: 'test', async dispatch() {
      attempts++;
      throw new PaseoWakeError('unknown outcome');
    } }],
  });
  assert.equal(attempts, 1);
});

test('Paseo rechecks presented attention after a running tool boundary', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const doc = writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  const notification = planActNotifications(doc, doc.acts[2])[0];
  const previousRegistry = process.env.SQUARE_REGISTRY;
  const previousPresented = process.env.SQUARE_PRESENTED;
  process.env.SQUARE_REGISTRY = registry;
  process.env.SQUARE_PRESENTED = presented;
  try {
    recordJoin('bob-session', 'Bob', file, {
      channel: 'codex',
      paseoAgentId: 'bob-agent',
      ownerId: 'bob-owner',
    });
    let sends = 0;
    await dispatchPaseoNotification(notification, { squarePath: file }, {
      discover: () => ({ agents: [{ id: 'bob-agent', name: 'Bob', status: 'running' }] }),
      waitForBoundary: async () => {
        presentOnce('bob-session', () => [{
          name: 'Bob',
          squarePath: file,
          notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'hey @Bob' }],
        }], () => true);
        return true;
      },
      sendWake: () => { sends++; },
    });
    assert.equal(sends, 0);
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    if (previousPresented === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previousPresented;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Paseo retries only provable discovery failures; timeout outcomes are unknown', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  const registry = path.join(root, 'sessions.ndjsonl');
  const doc = writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  const notification = planActNotifications(doc, doc.acts[2])[0];
  const previousRegistry = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registry;
  try {
    recordJoin('bob-session', 'Bob', file, {
      channel: 'codex',
      paseoAgentId: 'bob-agent',
      ownerId: 'bob-owner',
    });
    await assert.rejects(
      dispatchPaseoNotification(notification, { squarePath: file }, {
        discover: () => ({ agents: [], error: 'spawnSync paseo ENOENT' }),
      }),
      (error) => error instanceof PaseoWakeError && error.retryable === true
    );
    await assert.rejects(
      dispatchPaseoNotification(notification, { squarePath: file }, {
        discover: () => ({ agents: [], error: 'Paseo discovery timed out.' }),
      }),
      (error) => error instanceof PaseoWakeError && error.retryable === false
    );
    await assert.rejects(
      dispatchPaseoNotification(notification, { squarePath: file }, {
        discover: () => ({ agents: [{ id: 'bob-agent', name: 'Bob', status: 'running' }] }),
        waitForBoundary: async () => false,
      }),
      (error) => error instanceof PaseoWakeError && error.retryable === false
    );
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('notify-once skips attention presented to the current owner', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const previousRegistry = process.env.SQUARE_REGISTRY;
  const previousPresented = process.env.SQUARE_PRESENTED;
  process.env.SQUARE_REGISTRY = registry;
  process.env.SQUARE_PRESENTED = presented;
  try {
    recordJoin('bob-session', 'Bob', file, { channel: 'claude-code', ownerId: 'bob-owner' });
    fs.writeFileSync(
      presented,
      `${JSON.stringify({
        v: 2,
        ts: Date.now(),
        owner_id: 'bob-owner',
        square_path: path.resolve(file),
        name: 'Bob',
        act_index: 2,
      })}\n`
    );

    const dispatched = [];
    await processActNotificationsOnce(file, 2, {
      sinks: [{ name: 'test', async dispatch(notification) {
        dispatched.push(notification.recipient);
      } }],
    });
    assert.deepEqual(dispatched, []);

    recordJoin('replacement-session', 'Bob', file, { channel: 'claude-code', ownerId: 'replacement-owner' });
    const replacementDispatches = [];
    await processActNotificationsOnce(file, 2, {
      sinks: [{ name: 'test', async dispatch(notification) {
        replacementDispatches.push(notification.recipient);
      } }],
    });
    assert.deepEqual(replacementDispatches, ['Bob']);
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    if (previousPresented === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previousPresented;
  }
});

test('notify-once sends wake-only to the exact registered idle Paseo agent', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    ],
  });

  const registry = path.join(root, 'sessions.ndjsonl');
  const previousRegistry = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registry;
  try {
    recordJoin('bob-session', 'Bob', file, {
      channel: 'paseo',
      paseoAgentId: 'exact-agent-id',
    });
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
  }

  const bin = path.join(root, 'bin');
  const log = path.join(root, 'paseo-send.log');
  const presented = path.join(root, 'presented.ndjsonl');
  fs.mkdirSync(bin);
  const paseo = path.join(bin, 'paseo');
  fs.writeFileSync(
    paseo,
    `#!/bin/sh\nif [ "$1" = "ls" ]; then\n  printf '%s\\n' '[{"id":"same-name-decoy","name":"Bob","status":"idle"},{"id":"exact-agent-id","name":"Other","status":"idle"}]'\nelif [ "$1" = "send" ]; then\n  printf '%s\\n' "$@" > "$SQUARE_FAKE_PASEO_LOG"\nfi\n`
  );
  fs.chmodSync(paseo, 0o755);

  const worker = path.resolve(import.meta.dirname, '../dist/cmd/notify-once.js');
  const result = spawnSync(process.execPath, [worker, '--square-path', file, '--act-index', '2'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      SQUARE_REGISTRY: registry,
      SQUARE_PRESENTED: presented,
      SQUARE_NOTIFY_DELIVERY_WAIT_MS: '1',
      SQUARE_FAKE_PASEO_LOG: log,
    },
  });
  assert.equal(result.status, 0, result.stderr);

  for (let attempt = 0; attempt < 20 && !fs.existsSync(log); attempt++) await sleep(10);
  assert.equal(fs.existsSync(log), true);
  const sent = fs.readFileSync(log, 'utf8');
  assert.match(sent, /^send\nexact-agent-id\n/m);
  assert.match(sent, /native adapter/);
  assert.match(sent, /catch --now/);
  assert.doesNotMatch(sent, /hey @Bob/);
  assert.doesNotMatch(sent, /same-name-decoy/);
  assert.equal(fs.existsSync(presented), false);
});

test('an active matching catch receives the notification before Paseo wakes', async () => {
  const file = tempSquare();
  const root = path.dirname(file);
  const registry = path.join(root, 'sessions.ndjsonl');
  const log = path.join(root, 'paseo-send.log');
  const bin = path.join(root, 'bin');
  const paseo = path.join(bin, 'paseo');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    paseo,
    `#!/bin/sh\nif [ "$1" = "ls" ]; then\n  printf '%s\\n' '[{"id":"bob-agent","name":"Bob","status":"idle"}]'\nelif [ "$1" = "send" ]; then\n  printf '%s\\n' "$@" > "$SQUARE_FAKE_PASEO_LOG"\nfi\n`
  );
  fs.chmodSync(paseo, 0o755);

  const previous = {
    registry: process.env.SQUARE_REGISTRY,
    presented: process.env.SQUARE_PRESENTED,
    paseoBin: process.env.SQUARE_PASEO_BIN,
    disableWake: process.env.SQUARE_DISABLE_PASEO_WAKE,
    fakeLog: process.env.SQUARE_FAKE_PASEO_LOG,
  };
  process.env.SQUARE_REGISTRY = registry;
  process.env.SQUARE_PRESENTED = path.join(root, 'presented.ndjsonl');
  process.env.SQUARE_PASEO_BIN = paseo;
  process.env.SQUARE_DISABLE_PASEO_WAKE = '0';
  process.env.SQUARE_FAKE_PASEO_LOG = log;
  try {
    const doc = writeDoc(file, {
      acts: [
        { kind: 'join', actor: 'Alice', at: 1, body: '' },
        { kind: 'join', actor: 'Bob', at: 2, body: '' },
        { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
      ],
    });
    recordJoin('bob-session', 'Bob', file, {
      channel: 'paseo',
      paseoAgentId: 'bob-agent',
      ownerId: 'bob-owner',
    });
    const now = Date.now();
    doc.runtime.leases.Bob = {
      leaseId: 'catch-active',
      ownerId: 'bob-owner',
      heartbeatAt: now,
      expiresAt: now + 10_000,
    };
    saveRuntimeSidecar(file, doc.runtime);

    const wake = processActNotificationsOnce(file, 2);
    await sleep(25);
    doc.runtime.deliveryReceipts.Bob = { act_2: { status: 'delivered', at: Date.now() } };
    saveRuntimeSidecar(file, doc.runtime);
    await wake;

    assert.equal(fs.existsSync(log), false);
  } finally {
    if (previous.registry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous.registry;
    if (previous.presented === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previous.presented;
    if (previous.paseoBin === undefined) delete process.env.SQUARE_PASEO_BIN;
    else process.env.SQUARE_PASEO_BIN = previous.paseoBin;
    if (previous.disableWake === undefined) delete process.env.SQUARE_DISABLE_PASEO_WAKE;
    else process.env.SQUARE_DISABLE_PASEO_WAKE = previous.disableWake;
    if (previous.fakeLog === undefined) delete process.env.SQUARE_FAKE_PASEO_LOG;
    else process.env.SQUARE_FAKE_PASEO_LOG = previous.fakeLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Paseo carries only a wake when native and Paseo bindings share an owner', () => {
  const file = tempSquare();
  const root = path.dirname(file);
  writeDoc(file, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'private payload @Bob' },
    ],
  });

  const registry = path.join(root, 'sessions.ndjsonl');
  const previousRegistry = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registry;
  try {
    recordJoin('paseo-agent', 'Bob', file, {
      channel: 'paseo',
      paseoAgentId: 'paseo-agent',
      ownerId: 'shared-owner',
    });
    recordJoin('claude-session', 'Bob', file, {
      channel: 'claude-code',
      paseoAgentId: 'paseo-agent',
      ownerId: 'shared-owner',
    });
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
  }

  const bin = path.join(root, 'bin-native');
  const log = path.join(root, 'paseo-native.log');
  const presented = path.join(root, 'presented-native.ndjsonl');
  fs.mkdirSync(bin);
  const paseo = path.join(bin, 'paseo');
  fs.writeFileSync(
    paseo,
    `#!/bin/sh\nif [ "$1" = "ls" ]; then\n  printf '%s\\n' '[{"id":"paseo-agent","name":"Bob","status":"idle"}]'\nelif [ "$1" = "send" ]; then\n  printf '%s\\n' "$@" > "$SQUARE_FAKE_PASEO_LOG"\nfi\n`
  );
  fs.chmodSync(paseo, 0o755);

  const worker = path.resolve(import.meta.dirname, '../dist/cmd/notify-once.js');
  const result = spawnSync(process.execPath, [worker, '--square-path', file, '--act-index', '2'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      SQUARE_REGISTRY: registry,
      SQUARE_PRESENTED: presented,
      SQUARE_NOTIFY_DELIVERY_WAIT_MS: '1',
      SQUARE_FAKE_PASEO_LOG: log,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const sent = fs.readFileSync(log, 'utf8');
  assert.match(sent, /native adapter/);
  assert.match(sent, /catch --now/);
  assert.doesNotMatch(sent, /private payload/);
  assert.equal(fs.existsSync(presented), false);
});
