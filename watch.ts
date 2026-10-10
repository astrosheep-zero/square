import {
  type WatchOptions,
  isSquareError,
} from './model.js';
import {
  STALE_MS,
  WATCH_HEARTBEAT_MS,
  countSays,
  inSquareCount,
  nowMs,
} from './runtime.js';
import { openSquare } from './square-file-adapter.js';
import type { OpenSquare } from './open-square.js';
import { closeOpenSquare } from './open-square.js';
import { createSquareApplication } from './square-application.js';
import { resolveParticipant, watchPresentation } from './views.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease, type WatchLeaseStart } from './wakes.js';
import {
  renderWatchForceTakeover,
  renderWatchAlreadyActive,
  renderWatchReplaceMissing,
  renderWatchOutput,
  renderWatchReplaced,
  renderWatchStatus,
  formatRefusal,
  participantCommandPrefix,
  joinRecoveryCommand,
  participantsRecoveryCommand,
  withPathOutput,
  type WatchStatus,
} from './presentation.js';
import { hasAutomaticDeliveryIdentity } from './registry.js';
import { parseActivityId } from './square-core.js';
import type { CatchResult } from './square-facade.js';
import type { WatchPresentation } from './views.js';

type WatchResult =
  | { type: 'output'; stdout: string; remaining: number; status?: WatchStatus }
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
  opts: { participants?: string[]; mention?: string; limit?: number; status?: WatchStatus } = {}
): WatchResult {
  const delivered = caught.activities.flatMap((activity) => {
    const index = parseActivityId(activity.id);
    const stored = index === undefined ? undefined : presentation.activities.find((item) => item.index === index);
    return stored === undefined ? [] : [{ activity: stored, perception: activity.perception }];
  });
  // Catch delivers only directed say activities, so there is no lifecycle list to split off.
  const publicItems = delivered.map(({ activity }) => activity).filter((item) => item.kind === 'say' || item.kind === 'done');
  const perceptions = new Map(delivered.map(({ activity, perception }) => [activity.index, perception]));
  return {
    type: 'output',
    stdout: renderWatchOutput([...presentation.activities], publicItems, {
      ...opts,
      viewer: name,
      perceptions,
    }) + (caught.remaining > 0
      ? `\n○ ${caught.remaining} matching ${caught.remaining === 1 ? 'activity remains' : 'activities remain'}\n${catchContinuationCommand(squarePath, name, opts)}`
      : ''),
    remaining: caught.remaining,
    ...(opts.status ? { status: opts.status } : {}),
  };
}

function catchContinuationCommand(squarePath: string, name: string, opts: { participants?: string[]; mention?: string; limit?: number }): string {
  const args = ['--now'];
  if (opts.participants !== undefined && opts.participants.length > 0) args.push('--from', opts.participants.join(','));
  if (opts.mention !== undefined) args.push('--mention');
  if (opts.limit !== undefined) args.push('--limit', String(opts.limit));
  return `${participantCommandPrefix(squarePath, name)} catch ${args.join(' ')}`;
}

function writeWatchOutput(squarePath: string, name: string, presentation: WatchPresentation, stdout: string, remaining: number, status?: WatchStatus, idleMs?: number): void {
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

  const fallback = showCatchHint && remaining === 0
    ? `${participantCommandPrefix(squarePath, name)} catch --idle 30m\n  stay available for new activity`
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
        ownActivityCount: countSays(presentation.state.acts, name),
        hardCap: presentation.state.hardCap,
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
  square: OpenSquare,
  squarePath: string,
  name: string,
  result: WatchResult,
  leaseId: string | undefined,
  idleMs?: number
): Promise<boolean> {
  if (result.type === 'output') {
    await endWatch(square, name, leaseId);
    writeWatchOutput(squarePath, name, await watchPresentation(square, name), result.stdout, result.remaining, result.status);
    process.exitCode = watchStatusExitCode(result.status);
    return true;
  }
  if (result.type === 'terminal') {
    await endWatch(square, name, leaseId);
    writeWatchTerminal(squarePath, name, await watchPresentation(square, name), result.status, idleMs);
    process.exitCode = watchStatusExitCode(result.status);
    return true;
  }
  if (result.type === 'replaced') {
    writeWatchReplaced(squarePath, name, await watchPresentation(square, name));
    process.exitCode = 0;
    return true;
  }
  return false;
}

async function beginWatch(square: OpenSquare, squarePath: string, name: string, opts: WatchOptions): Promise<WatchLeaseStart> {
  const id = leaseId();
  return acquireWatchLease(square, name, id, opts);
}

async function endWatch(square: OpenSquare, name: string, id: string | undefined): Promise<void> {
  await releaseWatchLease(square, name, id);
}

function installWatchInterruptHandler(square: OpenSquare, squarePath: string, name: string, currentLeaseId: () => string | undefined): () => void {
  const onInterrupt = () => {
    void (async () => {
      await endWatch(square, name, currentLeaseId());
      process.stdout.write(withPathOutput(squarePath, '○ you step back — catch stopped'));
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

interface WatchCallerContext { readonly cwd: string; readonly env: NodeJS.ProcessEnv }
async function cmdWatchNow(squarePath: string, name: string, opts: WatchOptions, caller: WatchCallerContext): Promise<boolean> {
  const square = await openSquare(squarePath, { clock: nowMs, env: caller.env });
  const application = createSquareApplication({ cwd: caller.cwd, env: caller.env, squarePath, participant: name, clock: nowMs });
  try {
    const caught: CatchResult = await application.catch({
      ...(opts.id === undefined ? {} : { id: opts.id }),
      ...(opts.participants === undefined ? {} : { from: opts.participants }),
      ...(opts.mention === undefined ? {} : { mention: true }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
    const presentation = await watchPresentation(square, name);
    const status = presentation.terminalStatus;
    const result = caught.activities.length > 0
      ? watchOutputResult(squarePath, presentation, name, caught, { mention: opts.mention, participants: opts.participants, limit: opts.limit, ...(status ? { status } : {}) })
      : { type: 'terminal' as const, status: status ?? 'empty-now' as WatchStatus };
    await finishWatchResult(square, squarePath, name, result, undefined);
    return caught.activities.length > 0;
  } finally {
    await closeOpenSquare(square);
  }
}

async function countParticipants(square: OpenSquare): Promise<number | undefined> {
  try {
    return inSquareCount((await square.artifact.read()).state);
  } catch {
    return undefined;
  }
}

/** `false` is reserved for a quiet --now; idle completion preserves its existing sweep boundary. */
export async function cmdWatch(squarePath: string, name: string, opts: WatchOptions, caller: WatchCallerContext = { cwd: process.cwd(), env: { ...process.env } }): Promise<boolean | undefined> {
  let square: OpenSquare;
  let participantCount: number | undefined;
  try {
    square = await openSquare(squarePath, { clock: nowMs, env: caller.env });
    participantCount = inSquareCount((await square.artifact.read()).state);
    name = (await resolveParticipant(square, name)).name;
  } catch (err) {
    if (isSquareError(err)) {
      const bodyLines = [err.message];
      // The caller's own name has never joined; only a join admits it.
      if (err.facts?.reason === 'never_joined') bodyLines.push(joinRecoveryCommand(squarePath, name));
      process.stderr.write(formatRefusal(squarePath, bodyLines, participantCount === undefined ? {} : { participantCount }));
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
  try {
    if (opts.mention !== undefined) opts = { ...opts, mention: (await resolveParticipant(square, opts.mention)).name };
    if (opts.participants !== undefined && opts.participants.length > 0) {
      opts = { ...opts, participants: await Promise.all(opts.participants.map(async (participant) => (await resolveParticipant(square, participant)).name)) };
    }
  } catch (err) {
    const participantCount = await countParticipants(square);
    await closeOpenSquare(square).catch(() => undefined);
    if (isSquareError(err)) {
      const bodyLines = [err.message];
      // A filter target is unknown, not the caller; the roster is the useful next read.
      if (err.facts?.reason === 'never_joined' || err.facts?.reason === 'not_standing') bodyLines.push(participantsRecoveryCommand(squarePath));
      process.stderr.write(formatRefusal(squarePath, bodyLines, participantCount === undefined ? {} : { participantCount }));
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
  if (opts.now) {
    await closeOpenSquare(square);
    return cmdWatchNow(squarePath, name, opts, caller);
  }

  const start = await beginWatch(square, squarePath, name, opts);
  if (start.type === 'active') {
    const presentation = await watchPresentation(square, name);
    process.stdout.write(
      withPathOutput(squarePath, renderWatchAlreadyActive({ squarePath, name }), { participantCount: presentation.participantCount })
    );
    await closeOpenSquare(square);
    process.exit(1);
  }

  let staleSince = nowMs();
  let wasHeld = false;
  let currentLeaseId: string | undefined = start.leaseId;
  let nextHeartbeatAt = start.heartbeatAt + WATCH_HEARTBEAT_MS;
  if (opts.replace) {
    const presentation = await watchPresentation(square, name);
    process.stdout.write(
      withPathOutput(
        squarePath,
        start.replaced
          ? renderWatchForceTakeover({ squarePath, name })
          : renderWatchReplaceMissing({ squarePath, name }),
        { participantCount: presentation.participantCount }
      )
    );
  }
  const idleMs = opts.idleMs ?? STALE_MS;
  const removeInterruptHandler = installWatchInterruptHandler(square, squarePath, name, () => currentLeaseId);
  const application = createSquareApplication({ cwd: caller.cwd, env: caller.env, squarePath, participant: name, clock: nowMs });

  try {
    while (true) {
      // Capture before evaluation: changes during catch/lease checks must not be lost.
      const baseline = (await square.artifact.read()).version;
      const leaseState = await pulseWatchLease(square, name, currentLeaseId!, opts, nowMs() >= nextHeartbeatAt);
      if ((leaseState.type === 'sleep' || leaseState.type === 'held') && leaseState.heartbeatAt !== undefined) {
        nextHeartbeatAt = leaseState.heartbeatAt + WATCH_HEARTBEAT_MS;
      }

      let result: WatchResult = leaseState;
      if (result.type === 'sleep') {
        const caught = await application.catch({
          ...(opts.participants === undefined ? {} : { from: opts.participants }),
          ...(opts.mention === undefined ? {} : { mention: true }),
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        });
        if (caught.activities.length > 0) {
          result = watchOutputResult(squarePath, await watchPresentation(square, name), name, caught, { mention: opts.mention, participants: opts.participants, limit: opts.limit });
        }
      }

      if (await finishWatchResult(square, squarePath, name, result, currentLeaseId)) {
        currentLeaseId = undefined;
        return;
      }
      if (result.type === 'held' || wasHeld) staleSince = nowMs();
      wasHeld = result.type === 'held';

      if (!wasHeld && nowMs() - staleSince >= idleMs) {
        const result: WatchResult = !await ownsWatchLease(square, name, currentLeaseId!)
          ? { type: 'replaced' }
          : { type: 'terminal', status: 'stale' };

        if (await finishWatchResult(square, squarePath, name, result, currentLeaseId, idleMs)) {
          currentLeaseId = undefined;
          return;
        }
      }

      const nextDeadline = Math.min(nextHeartbeatAt, wasHeld ? Infinity : staleSince + idleMs);
      await square.artifact.changed(baseline, Math.max(0, nextDeadline - nowMs()));
    }
  } finally {
    await closeOpenSquare(square);
    removeInterruptHandler();
  }
}
