import { setTimeout as sleep } from 'node:timers/promises';

import { loadSquare } from './artifact.js';
import {
  type SquareDoc,
  type StoredAct,
  type WatchLease,
  type WatchOptions,
  SquareError,
  nameKey,
} from './model.js';
import { markDeliveredNotifications } from './delivery.js';
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
  touchPresenceCursor,
  writeWatchLease,
} from './runtime.js';
import { withSquareLock, writeSquareDoc } from './square-application.js';
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
import {
  ackPeerDelta,
  deliveryDelta,
  filteredPeerActivities,
  filteredRoomChanges,
  matchesFeedFilter,
  peerPublicActs,
  peerRoomChanges,
} from './activity-feed.js';
import { coreParticipants, resolveKnownName } from './decisions.js';
import { hasAutomaticDeliveryIdentity, localParticipantOwner } from './registry.js';
import { execute } from './square-application.js';

type WatchResult =
  | { type: 'output'; stdout: string; status?: WatchStatus }
  | { type: 'terminal'; status: WatchStatus }
  | { type: 'replaced' }
  | { type: 'held' }
  | { type: 'sleep' };

type WatchStartResult =
  | { type: 'started'; leaseId: string; replaced: boolean; heartbeatAt: number }
  | { type: 'active'; lease: WatchLease };

function catchDelta(doc: SquareDoc, name: string): StoredAct[] {
  return deliveryDelta(doc, name);
}

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

function consumeDelta(doc: SquareDoc, name: string, delta: StoredAct[], delivered: StoredAct[], at: number): boolean {
  const consumed = ackPeerDelta(doc, name, delta);
  const receipts = markDeliveredNotifications(doc, name, delivered, at);
  return consumed || receipts;
}

function watchOutputResult(
  squarePath: string,
  doc: SquareDoc,
  name: string,
  delta: StoredAct[],
  opts: { stalePartial?: boolean; participants?: string[]; mention?: string; status?: WatchStatus; idleMs?: number } = {}
): WatchResult {
  const publicItems = peerPublicActs(delta, name).filter((item) => matchesFeedFilter(item, opts));
  const roomChanges = filteredRoomChanges(delta, name, opts);
  consumeDelta(doc, name, delta, publicItems, nowMs());
  writeSquareDoc(squarePath, doc);
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
  const committed = await execute<
    | { type: 'active'; lease: WatchLease }
    | { type: 'started'; name: string; replaced: boolean }
  >(squarePath, {
    type: 'lease',
    name,
    leaseId: id,
    ...(ownerId === undefined ? {} : { ownerId }),
    at,
    expiresAt: at + WATCH_STALE_MS,
    force: opts.replace,
    filter: leaseFilter(opts),
  });
  if (committed.result.type === 'active') return committed.result;
  return { type: 'started', leaseId: id, replaced: committed.result.replaced, heartbeatAt: at };
}

async function endWatch(squarePath: string, name: string, id: string | undefined): Promise<void> {
  if (id === undefined) return;
  await execute(squarePath, { type: 'release-lease', name, leaseId: id });
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
  const result = await withSquareLock<WatchResult>(squarePath, () => {
    const doc = loadSquare(squarePath);
    const at = nowMs();
    const touched = touchPresenceCursor(doc, name, at);
    const delta = catchDelta(doc, name);
    const peerPublic = peerPublicActs(delta, name);
    const roomChanges = peerRoomChanges(delta, name);
    const filteredActivities = filteredPeerActivities(delta, name, opts);
    const matchingRoomChanges = filteredRoomChanges(delta, name, opts);
    const hasDeliverable = peerPublic.length > 0 || roomChanges.length > 0;
    const hasFilteredDeliverable = filteredActivities.length > 0 || matchingRoomChanges.length > 0;
    const status = terminalStatus(doc, name);

    if (hasDeliverable && hasFilteredDeliverable) {
      return watchOutputResult(squarePath, doc, name, delta, {
        participants: opts.participants,
        mention: opts.mention,
        ...(status ? { status } : {}),
      });
    }

    if (hasDeliverable) {
      const acked = ackPeerDelta(doc, name, delta);
      if (acked || touched) writeSquareDoc(squarePath, doc);
    } else if (touched) {
      writeSquareDoc(squarePath, doc);
    }
    if (status) return { type: 'terminal', status };
    return { type: 'terminal', status: 'empty-now' };
  });

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
    if (err instanceof SquareError) {
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

  try {
    while (true) {
      const result = await withSquareLock<WatchResult>(squarePath, () => {
        const doc = loadSquare(squarePath);
        const at = nowMs();
        const lease = freshWatchLease(doc, name, at);
        if (lease === undefined || lease.leaseId !== currentLeaseId) return { type: 'replaced' };

        let mutated = false;
        if (at >= nextHeartbeatAt) {
          setLease(doc, name, currentLeaseId!, at, opts, lease.ownerId);
          mutated = touchPresenceCursor(doc, name, at) || mutated;
          nextHeartbeatAt = at + WATCH_HEARTBEAT_MS;
          mutated = true;
        }

        const delta = catchDelta(doc, name);
        const peerPublic = peerPublicActs(delta, name);
        const roomChanges = peerRoomChanges(delta, name);
        const filteredActivities = filteredPeerActivities(delta, name, opts);
        const matchingRoomChanges = filteredRoomChanges(delta, name, opts);
        const hasDeliverable = peerPublic.length > 0 || roomChanges.length > 0;
        const hasFilteredDeliverable = filteredActivities.length > 0 || matchingRoomChanges.length > 0;
        const status = terminalStatus(doc, name);

        if (currentHold(doc.acts).active) {
          if (mutated) writeSquareDoc(squarePath, doc);
          return { type: 'held' };
        }

        if (
          hasDeliverable &&
          hasFilteredDeliverable &&
          (filteredActivities.length > 0 || matchingRoomChanges.length > 0 || status !== undefined)
        ) {
          return watchOutputResult(squarePath, doc, name, delta, {
            participants: opts.participants,
            mention: opts.mention,
            ...(status ? { status } : {}),
          });
        }

        if (hasDeliverable && !hasFilteredDeliverable) mutated = ackPeerDelta(doc, name, delta) || mutated;

        if (status) {
          if (mutated) writeSquareDoc(squarePath, doc);
          return { type: 'terminal', status };
        }

        if (mutated) writeSquareDoc(squarePath, doc);
        return { type: 'sleep' };
      });

      if (await finishWatchResult(squarePath, name, result, currentLeaseId)) {
        currentLeaseId = undefined;
        return;
      }
      if (result.type === 'held') staleSince = nowMs();

      if (nowMs() - staleSince >= idleMs) {
        const result = await withSquareLock<WatchResult>(squarePath, () => {
          const doc = loadSquare(squarePath);
          if (!sameLease(doc, name, currentLeaseId!)) return { type: 'replaced' };
          const delta = catchDelta(doc, name);
          const filteredActivities = filteredPeerActivities(delta, name, opts);
          if (filteredActivities.length > 0) {
            return watchOutputResult(squarePath, doc, name, delta, {
              stalePartial: true,
              participants: opts.participants,
              mention: opts.mention,
              idleMs,
            });
          }
          return { type: 'terminal', status: 'stale' };
        });

        if (await finishWatchResult(squarePath, name, result, currentLeaseId, idleMs)) {
          currentLeaseId = undefined;
          return;
        }
      }

      await sleep(SLEEP_MS);
    }
  } finally {
    removeInterruptHandler();
  }
}
