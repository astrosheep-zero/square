import { setTimeout as sleep } from 'node:timers/promises';

import {
  type WatchOptions,
  isSquareError,
} from './model.js';
import {
  SLEEP_MS,
  STALE_MS,
  WATCH_HEARTBEAT_MS,
  nowMs,
} from './runtime.js';
import { openFileApplication } from './square-file-adapter.js';
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
import { hasAutomaticDeliveryIdentity, localParticipantOwner } from './registry.js';
import { parseActivityId } from './square-core.js';
import type { CatchResult, SquareApplication, WatchLeaseStart, WatchPresentation } from './square-engine.js';

type WatchResult =
  | { type: 'output'; stdout: string; status?: WatchStatus }
  | { type: 'terminal'; status: WatchStatus }
  | { type: 'replaced' }
  | { type: 'held' }
  | { type: 'sleep' };

function watchStatusExitCode(status: WatchStatus | undefined): number {
  return status === 'capped' ? 1 : 0;
}

function leaseId(): string {
  return `watch_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function watchOutputResult(
  squarePath: string,
  presentation: WatchPresentation,
  name: string,
  caught: CatchResult,
  opts: { stalePartial?: boolean; participants?: string[]; mention?: string; status?: WatchStatus; idleMs?: number } = {}
): WatchResult {
  const delivered = caught.activities.flatMap((activity) => {
    const index = parseActivityId(activity.id);
    const stored = index === undefined ? undefined : presentation.activities.find((item) => item.index === index);
    return stored === undefined ? [] : [stored];
  });
  const publicItems = delivered.filter((item) => item.kind === 'say' || item.kind === 'done');
  const roomChanges = delivered.filter((item) => item.kind === 'join' || item.kind === 'done' || item.kind === 'hold' || item.kind === 'resume');
  return {
    type: 'output',
    stdout: renderWatchOutput([...presentation.activities], publicItems, roomChanges, {
      ...opts,
      squarePath,
      viewer: name,
      showCatchHint: !hasAutomaticDeliveryIdentity(),
    }),
    ...(opts.status ? { status: opts.status } : {}),
  };
}

function writeWatchOutput(squarePath: string, name: string, presentation: WatchPresentation, stdout: string, status?: WatchStatus, idleMs?: number): void {
  const headerOpts = { participantCount: presentation.participantCount };
  const showCatchHint = !hasAutomaticDeliveryIdentity();
  if (status) {
    process.stdout.write(
      withPathOutput(
        squarePath,
        [renderWatchStatus({ status, squarePath, name, idleMs, presence: presentation.presence, showCatchHint }), stdout.trimEnd()].filter(Boolean).join('\n\n').trimEnd(),
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

function writeWatchTerminal(squarePath: string, name: string, presentation: WatchPresentation, status: WatchStatus, idleMs?: number): void {
  process.stdout.write(
    withPathOutput(
      squarePath,
      renderWatchStatus({
        status,
        squarePath,
        name,
        ...(idleMs === undefined ? {} : { idleMs }),
        presence: presentation.presence,
        showCatchHint: !hasAutomaticDeliveryIdentity(),
      }),
      { participantCount: presentation.participantCount }
    )
  );
}

function writeWatchReplaced(squarePath: string, name: string, presentation: WatchPresentation): void {
  process.stdout.write(
    withPathOutput(squarePath, renderWatchReplaced({ squarePath, name }), { participantCount: presentation.participantCount })
  );
}

async function finishWatchResult(
  application: SquareApplication,
  squarePath: string,
  name: string,
  result: WatchResult,
  leaseId: string | undefined,
  idleMs?: number
): Promise<boolean> {
  if (result.type === 'output') {
    await endWatch(application, name, leaseId);
    writeWatchOutput(squarePath, name, await application.watchPresentation(name), result.stdout, result.status);
    process.exitCode = watchStatusExitCode(result.status);
    return true;
  }
  if (result.type === 'terminal') {
    await endWatch(application, name, leaseId);
    writeWatchTerminal(squarePath, name, await application.watchPresentation(name), result.status, idleMs);
    process.exitCode = watchStatusExitCode(result.status);
    return true;
  }
  if (result.type === 'replaced') {
    writeWatchReplaced(squarePath, name, await application.watchPresentation(name));
    process.exitCode = 0;
    return true;
  }
  return false;
}

async function beginWatch(application: SquareApplication, squarePath: string, name: string, opts: WatchOptions): Promise<WatchLeaseStart> {
  const id = leaseId();
  const ownerId = localParticipantOwner(squarePath, name);
  return application.acquireWatchLease(name, id, opts, ownerId);
}

async function endWatch(application: SquareApplication, name: string, id: string | undefined): Promise<void> {
  await application.releaseWatchLease(name, id);
}

function installWatchInterruptHandler(application: SquareApplication, squarePath: string, name: string, currentLeaseId: () => string | undefined): () => void {
  const onInterrupt = () => {
    void (async () => {
      await endWatch(application, name, currentLeaseId());
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

async function cmdWatchNow(squarePath: string, name: string, opts: WatchOptions): Promise<void> {
  const application = await openFileApplication(squarePath, { clock: nowMs });
  try {
    const caught: CatchResult = await application.catch(name, {
      ...(opts.participants === undefined ? {} : { from: opts.participants }),
      ...(opts.mention === undefined ? {} : { mention: true }),
    });
    const presentation = await application.watchPresentation(name);
    const status = presentation.terminalStatus;
    const result = caught.activities.length > 0
      ? watchOutputResult(squarePath, presentation, name, caught, { mention: opts.mention, ...(status ? { status } : {}) })
      : { type: 'terminal' as const, status: status ?? 'empty-now' as WatchStatus };
    await finishWatchResult(application, squarePath, name, result, undefined);
  } finally {
    await application.close();
  }
}

export async function cmdWatch(squarePath: string, name: string, opts: WatchOptions): Promise<void> {
  let application: SquareApplication;
  try {
    application = await openFileApplication(squarePath, { clock: nowMs });
    name = (await application.resolveParticipant(name)).name;
    if (opts.mention !== undefined) opts = { ...opts, mention: (await application.resolveParticipant(opts.mention)).name };
    if (opts.participants !== undefined && opts.participants.length > 0) {
      opts = { ...opts, participants: await Promise.all(opts.participants.map(async (participant) => (await application.resolveParticipant(participant)).name)) };
    }
  } catch (err) {
    if (isSquareError(err)) {
      process.stderr.write(err.message + '\n');
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
  if (opts.now) {
    await application.close();
    await cmdWatchNow(squarePath, name, opts);
    return;
  }

  const start = await beginWatch(application, squarePath, name, opts);
  if (start.type === 'active') {
    const presentation = await application.watchPresentation(name);
    process.stdout.write(
      withPathOutput(squarePath, renderWatchAlreadyActive({ squarePath, name }), { participantCount: presentation.participantCount })
    );
    await application.close();
    process.exit(1);
  }

  let staleSince = nowMs();
  let currentLeaseId: string | undefined = start.leaseId;
  let nextHeartbeatAt = start.heartbeatAt + WATCH_HEARTBEAT_MS;
  if (start.replaced) {
    const presentation = await application.watchPresentation(name);
    process.stdout.write(
      withPathOutput(squarePath, renderWatchForceTakeover({ squarePath, name }), { participantCount: presentation.participantCount })
    );
  }
  const idleMs = opts.idleMs ?? STALE_MS;
  const removeInterruptHandler = installWatchInterruptHandler(application, squarePath, name, () => currentLeaseId);

  try {
    while (true) {
      const leaseState = await application.pulseWatchLease(name, currentLeaseId!, opts, nowMs() >= nextHeartbeatAt);
      if (leaseState.type === 'sleep' && leaseState.heartbeatAt !== undefined) {
        nextHeartbeatAt = leaseState.heartbeatAt + WATCH_HEARTBEAT_MS;
      }

      let result: WatchResult = leaseState;
      if (result.type === 'sleep') {
        const caught = await application.catch(name, {
          ...(opts.participants === undefined ? {} : { from: opts.participants }),
          ...(opts.mention === undefined ? {} : { mention: true }),
        });
        if (caught.activities.length > 0) {
          result = watchOutputResult(squarePath, await application.watchPresentation(name), name, caught, { mention: opts.mention });
        }
      }

      if (await finishWatchResult(application, squarePath, name, result, currentLeaseId)) {
        currentLeaseId = undefined;
        return;
      }
      if (result.type === 'held') staleSince = nowMs();

      if (nowMs() - staleSince >= idleMs) {
        const result: WatchResult = !await application.ownsWatchLease(name, currentLeaseId!)
          ? { type: 'replaced' }
          : { type: 'terminal', status: 'stale' };

        if (await finishWatchResult(application, squarePath, name, result, currentLeaseId, idleMs)) {
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
