import { setTimeout as sleep } from 'node:timers/promises';

import { loadSquare } from './artifact.js';
import {
  type SquareDoc,
  type WatchLease,
  type WatchOptions,
  SquareError,
  isSquareError,
  nameKey,
} from './model.js';
import {
  SLEEP_MS,
  STALE_MS,
  WATCH_HEARTBEAT_MS,
  WATCH_STALE_MS,
  countSays,
  currentHold,
  doneNames,
  freshWatchLease,
  hasQuorum,
  inSquareCount,
  nowMs,
  removeWatchLease,
  touchPresenceCursor,
  writeWatchLease,
} from './runtime.js';
import { openFileApplication } from './square-file-adapter.js';
import { createFileCell } from './square-storage.js';
import {
  renderWatchForceTakeover,
  renderWatchAlreadyActive,
  renderWatchOutput,
  renderWatchReplaced,
  renderWatchStatus,
  participantCommandPrefix,
  withPathOutput,
  type WatchStatus,
} from './presentation.js';
import { coreParticipants, resolveKnownName } from './decisions.js';
import { hasAutomaticDeliveryIdentity, localParticipantOwner } from './registry.js';
import { parseActivityId } from './square-core.js';
import type { CatchResult } from './square-engine.js';

type WatchResult =
  | { type: 'output'; stdout: string; status?: WatchStatus }
  | { type: 'terminal'; status: WatchStatus }
  | { type: 'replaced' }
  | { type: 'held' }
  | { type: 'sleep' };

type WatchStartResult =
  | { type: 'started'; leaseId: string; replaced: boolean; heartbeatAt: number }
  | { type: 'active'; lease: WatchLease };

function watchStatusExitCode(status: WatchStatus | undefined): number {
  return status === 'capped' ? 1 : 0;
}

function leaseId(): string {
  return `watch_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function leaseFilter(opts: WatchOptions): WatchLease['filter'] | undefined {
  const filter = {
    ...(opts.participants !== undefined ? { participants: opts.participants } : {}),
    ...(opts.mention !== undefined ? { mention: opts.mention } : {}),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function setLease(doc: SquareDoc, name: string, id: string, at: number, opts: WatchOptions, ownerId?: string): void {
  const filter = leaseFilter(opts);
  writeWatchLease(doc, name, {
    leaseId: id,
    ...(ownerId === undefined ? {} : { ownerId }),
    heartbeatAt: at,
    expiresAt: at + WATCH_STALE_MS,
    ...(filter ? { filter } : {}),
  });
}

function sameLease(doc: SquareDoc, name: string, id: string, at = nowMs()): boolean {
  return freshWatchLease(doc, name, at)?.leaseId === id;
}

function watchOutputResult(
  squarePath: string,
  doc: SquareDoc,
  name: string,
  caught: CatchResult,
  opts: { stalePartial?: boolean; participants?: string[]; mention?: string; status?: WatchStatus; idleMs?: number } = {}
): WatchResult {
  const delivered = caught.activities.flatMap((activity) => {
    const index = parseActivityId(activity.id);
    const stored = index === undefined ? undefined : doc.acts.find((item) => item.index === index);
    return stored === undefined ? [] : [stored];
  });
  const publicItems = delivered.filter((item) => item.kind === 'say' || item.kind === 'done');
  const roomChanges = delivered.filter((item) => item.kind === 'join' || item.kind === 'done' || item.kind === 'hold' || item.kind === 'resume');
  return {
    type: 'output',
    stdout: renderWatchOutput(doc.acts, publicItems, roomChanges, {
      ...opts,
      squarePath,
      viewer: name,
      showCatchHint: !hasAutomaticDeliveryIdentity(),
    }),
    ...(opts.status ? { status: opts.status } : {}),
  };
}

function loadPresence(squarePath: string): { participants: ReturnType<typeof coreParticipants>; now: number } | undefined {
  try {
    const doc = loadSquare(squarePath);
    const now = nowMs();
    return { participants: coreParticipants(doc, now), now };
  } catch {
    return undefined;
  }
}

function loadHeaderCount(squarePath: string): number | undefined {
  try {
    return inSquareCount(loadSquare(squarePath));
  } catch {
    return undefined;
  }
}

function writeWatchOutput(squarePath: string, name: string, stdout: string, status?: WatchStatus, idleMs?: number): void {
  const presence = loadPresence(squarePath);
  const headerOpts = { participantCount: loadHeaderCount(squarePath) };
  const showCatchHint = !hasAutomaticDeliveryIdentity();
  if (status) {
    process.stdout.write(
      withPathOutput(
        squarePath,
        [renderWatchStatus({ status, squarePath, name, idleMs, presence, showCatchHint }), stdout.trimEnd()].filter(Boolean).join('\n\n').trimEnd(),
        headerOpts
      )
    );
    return;
  }

  const fallback = showCatchHint
    ? `» ${participantCommandPrefix(squarePath, name)} catch --idle 30m\n  stay available for new activity`
    : '';
  process.stdout.write(
    withPathOutput(squarePath, [stdout.trimEnd(), fallback].filter(Boolean).join('\n\n').trimEnd(), headerOpts)
  );
}

function writeWatchTerminal(squarePath: string, name: string, status: WatchStatus, idleMs?: number): void {
  const presence = loadPresence(squarePath);
  process.stdout.write(
    withPathOutput(
      squarePath,
      renderWatchStatus({
        status,
        squarePath,
        name,
        ...(idleMs === undefined ? {} : { idleMs }),
        presence,
        showCatchHint: !hasAutomaticDeliveryIdentity(),
      }),
      { participantCount: loadHeaderCount(squarePath) }
    )
  );
}

function writeWatchReplaced(squarePath: string, name: string): void {
  process.stdout.write(
    withPathOutput(squarePath, renderWatchReplaced({ squarePath, name }), { participantCount: loadHeaderCount(squarePath) })
  );
}

async function finishWatchResult(
  squarePath: string,
  name: string,
  result: WatchResult,
  leaseId: string | undefined,
  idleMs?: number
): Promise<boolean> {
  if (result.type === 'output') {
    await endWatch(squarePath, name, leaseId);
    writeWatchOutput(squarePath, name, result.stdout, result.status);
    process.exitCode = watchStatusExitCode(result.status);
    return true;
  }
  if (result.type === 'terminal') {
    await endWatch(squarePath, name, leaseId);
    writeWatchTerminal(squarePath, name, result.status, idleMs);
    process.exitCode = watchStatusExitCode(result.status);
    return true;
  }
  if (result.type === 'replaced') {
    writeWatchReplaced(squarePath, name);
    process.exitCode = 0;
    return true;
  }
  return false;
}

async function beginWatch(squarePath: string, name: string, opts: WatchOptions): Promise<WatchStartResult> {
  const at = nowMs();
  const id = leaseId();
  const ownerId = localParticipantOwner(squarePath, name);
  const cell = createFileCell(squarePath);
  try {
    return await cell.transact<WatchStartResult>((doc) => {
      const known = resolveKnownName(doc, name);
      const existing = freshWatchLease(doc, known, at);
      if (existing !== undefined && !opts.replace) return { result: { type: 'active', lease: existing } };
      setLease(doc, known, id, at, opts, ownerId);
      touchPresenceCursor(doc, known, at);
      return { state: doc, result: { type: 'started', leaseId: id, replaced: existing !== undefined, heartbeatAt: at } };
    });
  } finally {
    await cell.close();
  }
}

async function endWatch(squarePath: string, name: string, id: string | undefined): Promise<void> {
  if (id === undefined) return;
  const cell = createFileCell(squarePath);
  try {
    await cell.transact((doc) => {
      const known = resolveKnownName(doc, name);
      if (!removeWatchLease(doc, known, id)) return { result: undefined };
      return { state: doc, result: undefined };
    });
  } finally {
    await cell.close();
  }
}

function installWatchInterruptHandler(squarePath: string, name: string, currentLeaseId: () => string | undefined): () => void {
  const onInterrupt = () => {
    void (async () => {
      await endWatch(squarePath, name, currentLeaseId());
      process.stdout.write(withPathOutput(squarePath, '✕ catch stopped'));
      process.exit(130);
    })().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(130);
    });
  };
  process.once('SIGINT', onInterrupt);
  return () => {
    process.off('SIGINT', onInterrupt);
  };
}

function terminalStatus(doc: SquareDoc, name: string): WatchStatus | undefined {
  const count = countSays(doc.acts, name);
  if (doc.hardCap !== null && count >= doc.hardCap) return 'capped';

  const done = doneNames(doc.acts);
  done.delete(nameKey(name));
  if (hasQuorum(doc, name, done)) return 'quorum';
  return undefined;
}

async function cmdWatchNow(squarePath: string, name: string, opts: WatchOptions): Promise<void> {
  const application = await openFileApplication(squarePath, { clock: nowMs });
  let caught: CatchResult;
  try {
    caught = await application.catch(name, {
      ...(opts.participants === undefined ? {} : { from: opts.participants }),
      ...(opts.mention === undefined ? {} : { mention: true }),
    });
  } finally {
    await application.close();
  }
  const doc = loadSquare(squarePath);
  const status = terminalStatus(doc, name);
  const result = caught.activities.length > 0
    ? watchOutputResult(squarePath, doc, name, caught, { mention: opts.mention, ...(status ? { status } : {}) })
    : { type: 'terminal' as const, status: status ?? 'empty-now' as WatchStatus };

  await finishWatchResult(squarePath, name, result, undefined);
}

export async function cmdWatch(squarePath: string, name: string, opts: WatchOptions): Promise<void> {
  let initialDoc: SquareDoc;
  try {
    initialDoc = loadSquare(squarePath);
    name = resolveKnownName(initialDoc, name);
    if (opts.mention !== undefined) opts = { ...opts, mention: resolveKnownName(initialDoc, opts.mention) };
    if (opts.participants !== undefined && opts.participants.length > 0) {
      opts = { ...opts, participants: opts.participants.map((p) => resolveKnownName(initialDoc, p)) };
    }
  } catch (err) {
    if (isSquareError(err)) {
      process.stderr.write(err.message + '\n');
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
  if (opts.now) {
    await cmdWatchNow(squarePath, name, opts);
    return;
  }

  const start = await beginWatch(squarePath, name, opts);
  if (start.type === 'active') {
    process.stdout.write(
      withPathOutput(squarePath, renderWatchAlreadyActive({ squarePath, name }), { participantCount: loadHeaderCount(squarePath) })
    );
    process.exit(1);
  }

  let staleSince = nowMs();
  let currentLeaseId: string | undefined = start.leaseId;
  let nextHeartbeatAt = start.heartbeatAt + WATCH_HEARTBEAT_MS;
  if (start.replaced) {
    process.stdout.write(
      withPathOutput(squarePath, renderWatchForceTakeover({ squarePath, name }), { participantCount: loadHeaderCount(squarePath) })
    );
  }
  const idleMs = opts.idleMs ?? STALE_MS;
  const removeInterruptHandler = installWatchInterruptHandler(squarePath, name, () => currentLeaseId);
  const application = await openFileApplication(squarePath, { clock: nowMs });

  try {
    while (true) {
      const cell = createFileCell(squarePath);
      const leaseState = await cell.transact<WatchResult>((doc) => {
        const at = nowMs();
        const lease = freshWatchLease(doc, name, at);
        if (lease === undefined || lease.leaseId !== currentLeaseId) return { result: { type: 'replaced' } };
        if (currentHold(doc.acts).active) return { result: { type: 'held' } };
        const status = terminalStatus(doc, name);
        if (status) return { result: { type: 'terminal', status } };
        if (at < nextHeartbeatAt) return { result: { type: 'sleep' } };
        setLease(doc, name, currentLeaseId!, at, opts, lease.ownerId);
        touchPresenceCursor(doc, name, at);
        nextHeartbeatAt = at + WATCH_HEARTBEAT_MS;
        return { state: doc, result: { type: 'sleep' } };
      });
      await cell.close();

      let result = leaseState;
      if (result.type === 'sleep') {
        const caught = await application.catch(name, {
          ...(opts.participants === undefined ? {} : { from: opts.participants }),
          ...(opts.mention === undefined ? {} : { mention: true }),
        });
        if (caught.activities.length > 0) {
          const doc = loadSquare(squarePath);
          result = watchOutputResult(squarePath, doc, name, caught, { mention: opts.mention });
        }
      }

      if (await finishWatchResult(squarePath, name, result, currentLeaseId)) {
        currentLeaseId = undefined;
        return;
      }
      if (result.type === 'held') staleSince = nowMs();

      if (nowMs() - staleSince >= idleMs) {
        const doc = loadSquare(squarePath);
        const result: WatchResult = !sameLease(doc, name, currentLeaseId!)
          ? { type: 'replaced' }
          : { type: 'terminal', status: 'stale' };

        if (await finishWatchResult(squarePath, name, result, currentLeaseId, idleMs)) {
          currentLeaseId = undefined;
          return;
        }
      }

      await sleep(SLEEP_MS);
    }
  } finally {
    await application.close();
    removeInterruptHandler();
  }
}
