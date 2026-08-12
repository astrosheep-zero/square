import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { emptyRuntimeState, loadSquare, renderSquareDoc, saveRuntimeSidecar } from '../dist/artifact.js';
import {
  doctorDeliveryHealth,
  formatStaleDeliveryWarnings,
  partitionPendingDeliveries,
} from '../dist/delivery-health.js';
import { notificationMessageId } from '../dist/delivery.js';
import { claudeHookResponse } from '../dist/claude-hook.js';
import { recordNotificationFailure } from '../dist/notification-failures.js';

function writeDoc(file, acts, runtimeOverrides = {}) {
  const indexed = acts.map((act, index) => ({ ...act, index }));
  const runtime = {
    ...emptyRuntimeState(indexed.length),
    nextActIndex: indexed.length,
    ...runtimeOverrides,
  };
  const doc = { hardCap: null, preamble: [], warmup: ['w'], acts: indexed, runtime };
  fs.writeFileSync(file, renderSquareDoc(doc));
  saveRuntimeSidecar(file, runtime);
  return { doc, runtime };
}

test('recent stale pending notifications surface while still undelivered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-stale-'));
  const file = path.join(dir, 'square.md');
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
  ]);

  const now = 3 + 61_000;
  const stale = partitionPendingDeliveries(file, { now, staleMs: 60_000, lookbackMs: 3_600_000 }).recent;
  assert.equal(stale.length, 1);
  assert.equal(stale[0].recipient, 'Bob');
  assert.equal(stale[0].actIndex, 2);
  assert.match(formatStaleDeliveryWarnings(stale).join('\n'), /@Bob/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('older canonical pending notifications become historical backlog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-stale-hist-'));
  const file = path.join(dir, 'square.md');
  const t0 = 1_000_000;
  const now = t0 + 10_000_000;
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: t0, body: '' },
    { kind: 'join', actor: 'Bob', at: t0 + 1, body: '' },
    { kind: 'join', actor: 'Cara', at: t0 + 2, body: '' },
    { kind: 'say', actor: 'Alice', at: t0 + 3, body: 'old @Bob' },
    { kind: 'say', actor: 'Alice', at: now - 120_000, body: 'fresh @Cara' },
    // Dana joined after the activity, so it is not a canonical pending delivery.
    { kind: 'say', actor: 'Alice', at: now - 90_000, body: 'before join @Dana' },
    { kind: 'join', actor: 'Dana', at: now - 30_000, body: '' },
  ]);
  const part = partitionPendingDeliveries(file, {
    now,
    staleMs: 60_000,
    lookbackMs: 3_600_000,
  });
  assert.equal(part.historical.some((item) => item.recipient === 'Bob'), true);
  assert.equal(part.historical.some((item) => item.recipient === 'Dana'), false);
  assert.deepEqual(
    part.recent.map((s) => s.recipient),
    ['Cara']
  );
  const text = formatStaleDeliveryWarnings(part.recent, part.historical, { previousBacklog: 1 }).join('\n');
  assert.match(text, /older pending notification/);
  assert.match(text, /@Cara/);
  assert.match(text, /backlog unchanged/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('delivery health follows stable post-join order, not activity timestamps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-stale-order-'));
  const file = path.join(dir, 'square.md');
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: 10, body: '' },
    // Its timestamp is later than Bob's join, but its stable index is earlier.
    { kind: 'say', actor: 'Alice', at: 90, body: 'before join @Bob' },
    { kind: 'join', actor: 'Bob', at: 1, body: '' },
    { kind: 'say', actor: 'Alice', at: 2, body: 'after join @Bob' },
  ]);

  const pending = partitionPendingDeliveries(file, {
    now: 120_000,
    staleMs: 60_000,
    lookbackMs: 3_600_000,
  }).recent;
  assert.deepEqual(pending.map(({ actIndex, recipient }) => [actIndex, recipient]), [[3, 'Bob']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only a canonical delivered receipt clears stale health', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-stale-ok-'));
  const file = path.join(dir, 'square.md');
  const { runtime } = writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
  ]);
  assert.equal(partitionPendingDeliveries(file, { now: 3 + 61_000 }).recent.length, 1);

  // Presented is not a valid sidecar state; the machine-local ledger owns it.
  runtime.deliveryReceipts.Bob = { act_2: { status: 'presented', at: 4 } };
  assert.throws(() => saveRuntimeSidecar(file, runtime), /deliveryReceipts/);

  runtime.deliveryReceipts.Bob = { act_2: { status: 'delivered', at: 5 } };
  saveRuntimeSidecar(file, runtime);
  assert.deepEqual(partitionPendingDeliveries(file, { now: 3 + 61_000 }).recent, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recent liveness flags recipient who acted after a notification without delivery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-adapter-fault-'));
  const file = path.join(dir, 'square.md');
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
    { kind: 'say', actor: 'Bob', at: 4, body: 'still working without watch' },
  ]);
  const stale = partitionPendingDeliveries(file, { now: 3 + 61_000, staleMs: 60_000, lookbackMs: 3_600_000 }).recent;
  assert.equal(stale.length, 1);
  assert.equal(stale[0].actedAfterWithoutDelivery, true);
  assert.match(formatStaleDeliveryWarnings(stale).join('\n'), /adapter\/pull dead|adapter failure/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('boundary context carries stable message ids and is presented once', () => {
  const inbox = [{
    name: 'Bob',
    squarePath: '/tmp/square.md',
    notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'hello @Bob' }],
  }];
  const id = notificationMessageId('/tmp/square.md', 2);
  const presented = path.join(os.tmpdir(), `p-${Date.now()}.ndjsonl`);
  const response = claudeHookResponse(
    { session_id: 's', hook_event_name: 'PostToolBatch' },
    () => inbox,
    { SQUARE_PRESENTED: presented }
  );
  assert.match(response.hookSpecificOutput.additionalContext, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(response.hookSpecificOutput.additionalContext, /Ids are stable across boundaries/);
  assert.equal(
    claudeHookResponse(
      { session_id: 's', hook_event_name: 'PostToolBatch' },
      () => inbox,
      { SQUARE_PRESENTED: presented }
    ),
    undefined
  );
  fs.rmSync(presented, { force: true });
});

test('doctor health records backlog baseline delta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-baseline-'));
  const file = path.join(dir, 'square.md');
  const baseline = path.join(dir, 'baseline.json');
  const env = { SQUARE_DELIVERY_BASELINE: baseline };
  const t0 = 1_000_000;
  const now = t0 + 10_000_000;
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: t0, body: '' },
    { kind: 'join', actor: 'Bob', at: t0 + 1, body: '' },
    { kind: 'say', actor: 'Alice', at: t0 + 3, body: 'old @Bob' },
  ]);
  const first = doctorDeliveryHealth(file, now, env).join('\n');
  assert.match(first, /older pending notification/);
  // Add another old unreceipted by rewriting with Cara still joined after an old mention.
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: t0, body: '' },
    { kind: 'join', actor: 'Bob', at: t0 + 1, body: '' },
    { kind: 'join', actor: 'Cara', at: t0 + 2, body: '' },
    { kind: 'say', actor: 'Alice', at: t0 + 3, body: 'old @Bob' },
    { kind: 'say', actor: 'Alice', at: t0 + 4, body: 'old @Cara' },
  ]);
  const second = doctorDeliveryHealth(file, now, env).join('\n');
  assert.match(second, /backlog grew by 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('doctor explains a recorded Paseo failure for a recent pending notification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-paseo-failure-'));
  const file = path.join(dir, 'square.md');
  const failures = path.join(dir, 'notification-failures.ndjsonl');
  const now = 3 + 61_000;
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
  ]);
  recordNotificationFailure(file, {
    actIndex: 2,
    recipient: 'Bob',
    route: 'mention',
    sink: 'paseo',
    message: 'Paseo unavailable: auth_required',
  }, now - 1_000, { SQUARE_NOTIFICATION_FAILURES: failures });
  const output = doctorDeliveryHealth(file, now, {
    SQUARE_DELIVERY_BASELINE: path.join(dir, 'baseline.json'),
    SQUARE_NOTIFICATION_FAILURES: failures,
    SQUARE_DELIVERY_STALE_MS: '60000',
    SQUARE_DELIVERY_LOOKBACK_MS: '3600000',
  }).join('\n');
  assert.match(output, /notification attempt\(s\) failed/);
  assert.match(output, /Paseo unavailable: auth_required/);
  assert.match(output, /receipt remains pending/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('doctor retains a delivered notification\'s Paseo wake failure for diagnosis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-paseo-history-'));
  const file = path.join(dir, 'square.md');
  const failures = path.join(dir, 'notification-failures.ndjsonl');
  const now = 3 + 120_000;
  writeDoc(file, [
    { kind: 'join', actor: 'Alice', at: 1, body: '' },
    { kind: 'join', actor: 'Bob', at: 2, body: '' },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' },
  ], {
    deliveryReceipts: { Bob: { act_2: { status: 'delivered', at: 4 } } },
  });
  recordNotificationFailure(file, {
    actIndex: 2,
    recipient: 'Bob',
    route: 'mention',
    sink: 'paseo',
    message: 'Paseo unavailable: DAEMON_NOT_RUNNING',
    diagnostic: {
      phase: 'discovery',
      code: 'unavailable',
      command: 'paseo ls --json',
      endpoint: '100.126.66.71:6767',
      paseoAgentIds: ['agent-root'],
      ownerIds: ['owner-root'],
      passwordPresent: false,
    },
  }, now - 1_000, { SQUARE_NOTIFICATION_FAILURES: failures });
  const output = doctorDeliveryHealth(file, now, {
    SQUARE_DELIVERY_BASELINE: path.join(dir, 'baseline.json'),
    SQUARE_NOTIFICATION_FAILURES: failures,
    SQUARE_DELIVERY_STALE_MS: '60000',
    SQUARE_DELIVERY_LOOKBACK_MS: '3600000',
  }).join('\n');
  assert.match(output, /no stale undelivered notifications/);
  assert.match(output, /historical notification failure\(s\) retained/);
  assert.match(output, /PASEO_PASSWORD absent/);
  assert.match(output, /pass PASEO_PASSWORD to the Codex process/);
  assert.match(output, new RegExp(failures.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  fs.rmSync(dir, { recursive: true, force: true });
});
