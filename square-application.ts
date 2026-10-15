import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SquareError, isSquareError, nameKey, validateName, type WatchOptions } from './model.js';
import { validateDoneBody } from './decisions.js';
import { HELD_WAIT_BUDGET_MS, WATCH_HEARTBEAT_MS, inSquareCount, readCursor, watchTerminalStatus } from './runtime.js';
import { formatActivityId } from './square-core.js';
import { catchLimit } from './catch-decisions.js';
import { directedSuffix } from './activity-feed.js';
import { assertLiveOwner } from './participant-host.js';
import type { HostLedgerPort, WakeTransportPort } from './ports.js';
import { buildMemorySquare, buildSquare, createSquare, openSquare } from './square-file-adapter.js';
import { closeOpenSquare, type OpenSquare } from './open-square.js';
import { catchUp, done, endOwnedSession, express, hold, ignore, implicitJoin, join, takeover, listen, listening, resume, retireEndedSessionRoutes, type ExpressCommittedResult } from './square-actions.js';
import {
  recoveryObservation, applicationHistory, currentParticipant, entryPresentation, eventPresentation,
  history, participantHistory, participants, resolveParticipant, snapshot, statusPresentation,
  participantsPresentation, catchPresence, toPublicActivity,
} from './views.js';
import { hasAutomaticDeliveryIdentity, hostLedgerForEnv, localParticipantName, localSessionIdentities, presenceEpoch, readParticipantOwner } from './registry.js';
import { projectSessionBindings } from './square-projections.js';
import { sessionIdsFromEnvironment } from './participant-identity.js';
import { createDefaultWakeTransport, wakeGraceMs } from './notifications.js';
import { sweepPending } from './delivery-operations.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease } from './wakes.js';
import { diagnoseSquareFile } from './square-storage.js';
import { migrateSquareFile } from './square-migration.js';
import { discoverSquares, DEFAULT_LIST_DEPTH, DEFAULT_LIST_LIMIT } from './list.js';
import { streamSquare } from './stream.js';
import type { Activity, ApplicationFailureDetail, ApplicationOutcome, CatchApplicationData, CatchApplicationOptions, CatchProjection, CatchResult, CatchSelectionObservation, CatchStopStatus, ExpressApplicationOptions, ExpressApplicationData, ExpressProjection, ExpressOptions, ExpressResult, HistoryQuery, JoinApplicationOptions, JoinApplicationData, ListenerChangeResult, OperationControl, Participant, ParticipantStatus, SquareApplication, SquareApplicationContext, SquareAtInput, SquareBuildInput, SquareContextProjection, SquareSnapshot } from './square-facade.js';

export type * from './square-facade.js';
export { formatActivityId, parseActivityId, MAX_IDENTITY_SET_SIZE } from './square-core.js';
export { CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT } from './catch-decisions.js';
export { HELD_WAIT_BUDGET_MS } from './runtime.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './views.js';
export { DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './list.js';

function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Square operation was cancelled');
}
function clockFor(env: NodeJS.ProcessEnv, clock?: () => number): () => number {
  if (clock !== undefined) return clock;
  if (env.SQUARE_NOW_MS === undefined) return Date.now;
  return () => {
    const value = Number.parseInt(env.SQUARE_NOW_MS!, 10);
    if (!Number.isFinite(value)) throw new SquareError('invalid_args', 'Invalid SQUARE_NOW_MS: expected integer milliseconds.');
    return value;
  };
}
function failure(error: unknown, detail: ApplicationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}
function defaultTransport(
  square: Pick<OpenSquare, 'clock' | 'hostLedger' | 'wakeTransport' | 'env'>, inMemory = false,
): () => Promise<WakeTransportPort | undefined> {
  let transport: Promise<WakeTransportPort | undefined> | undefined;
  return () => transport ??= square.wakeTransport !== undefined ? Promise.resolve(square.wakeTransport)
    : inMemory || square.hostLedger === undefined ? Promise.resolve(undefined)
      : createDefaultWakeTransport(square.hostLedger, square.clock, square.env).catch(() => undefined);
}
function observedContext(
  square: OpenSquare, standingCount: number, held: boolean, participant?: string, now = square.clock(),
): SquareContextProjection {
  return {
    location: square.location, standingCount, held, now,
    ...(participant === undefined ? {} : { participant }),
    automaticDeliveryAvailable: hasAutomaticDeliveryIdentity(square.env),
  };
}
async function contextProjection(square: OpenSquare, participant?: string, control?: OperationControl): Promise<SquareContextProjection> {
  const observation = (await square.artifact.read((facts) => ({
    standingCount: inSquareCount(facts), held: facts.hold().active,
  }), control?.signal)).value;
  return observedContext(square, observation.standingCount, observation.held, participant);
}

async function joinOwned(square: OpenSquare, requested: string, options: JoinApplicationOptions = {}, control?: OperationControl): Promise<JoinApplicationData> {
  checkControl(control);
  if (options.takeover && await currentParticipant(square, requested, control) !== undefined) {
    const result = await takeover(square, requested, [], control);
    return {
      participant: result.name, activity: result.activities.at(-1) ?? null,
      kind: 'taken-over', participantCount: result.participantCount,
    };
  }
  const result = await join(square, requested, control);
  return {
    participant: result.name, activity: result.activity,
    kind: result.reconnected ? 'reconnected' : 'joined', participantCount: result.participantCount,
  };
}

async function prepareExpression(square: OpenSquare, requested: string, control?: OperationControl) {
  try {
    checkControl(control);
    const name = (await resolveParticipant(square, requested, control)).name;
    return await joinOwned(square, name, {}, control);
  } catch (error) {
    throw failure(error, { operation: 'express', subject: 'caller', participant: requested, expressEffect: 'unsent' });
  }
}

/** The one retry/commit owner, shared by application and SDK without projections. */
async function landExpression(
  square: OpenSquare, name: string, body: string, options: ExpressApplicationOptions,
  transport: () => Promise<WakeTransportPort | undefined>, control?: OperationControl,
): Promise<ExpressCommittedResult & { readonly waited: boolean }> {
  let effect: 'unsent' | 'unknown' = 'unsent';
  let waited = false;
  let heldWaitedMs = 0;
  try {
    const wakeTransport = await transport();
    while (true) {
      checkControl(control);
      try {
        effect = 'unknown';
        const result = await express({ ...square, wakeTransport }, name, body, options, control);
        return { ...result, waited };
      } catch (error) {
        if (isSquareError(error) && error.facts?.activityUnsent === true) effect = 'unsent';
        if (!isSquareError(error) || options.noWait || (error.code !== 'held' && error.code !== 'throttled')) throw error;
        if (error.code === 'held' && heldWaitedMs >= HELD_WAIT_BUDGET_MS) throw error;
        waited = true;
        control?.onProgress?.({
          kind: 'waiting', reason: error.code,
          ...(error.code === 'throttled' ? { delayMs: error.facts?.retryAfterMs ?? 1 } : {}),
          ...(error.facts?.holder === undefined ? {} : { holder: error.facts.holder }),
          ...(error.facts?.holdReason === undefined ? {} : { holdReason: error.facts.holdReason }),
        });
        if (error.code === 'throttled') {
          await sleep(error.facts?.retryAfterMs ?? 1, undefined, { signal: control?.signal });
        } else {
          const started = Date.now();
          const observation = await square.artifact.read((facts) => facts.hold().active, control?.signal);
          if (observation.value) {
            await square.artifact.changed(observation.version,
              Math.max(1, HELD_WAIT_BUDGET_MS - heldWaitedMs), control?.signal);
          }
          heldWaitedMs += Date.now() - started;
        }
      }
    }
  } catch (error) {
    const recipient = isSquareError(error)
      && ['not_standing', 'unmatched_mention', 'bell_mention_conflict'].includes(error.facts?.reason ?? '');
    throw failure(error, {
      operation: 'express', participant: name, subject: recipient ? 'recipient' : 'caller', expressEffect: effect,
    });
  }
}

async function expressOwned(
  square: OpenSquare, requested: string, body: string, options: ExpressApplicationOptions,
  transport: () => Promise<WakeTransportPort | undefined>, control?: OperationControl,
): Promise<ApplicationOutcome<ExpressApplicationData, ExpressProjection>> {
  const entry = await prepareExpression(square, requested, control);
  const name = entry.participant;
  let result: (ExpressCommittedResult & { readonly waited: boolean }) | undefined;
  try {
    const feed = (await square.artifact.read((facts) => {
      const pendingPublic = directedSuffix(facts, name);
      return {
        pendingPublic,
        sayNumbers: facts.sayOrdinals(pendingPublic.map((item) => item.index)),
        perceptions: Object.fromEntries(pendingPublic.map((item) => [item.index, 'full' as const])),
      };
    }, control?.signal)).value;
    result = await landExpression(square, name, body, options, transport, control);
    // Minimal count/header facts come from the authoritative commit, not a later
    // read that could erase success or a second feed that would be discarded.
    const fresh = result.observation;
    return {
      data: {
        activity: result.activity, waited: result.waited,
        ...(result.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: result.replyAuthorNotHere }),
      },
      projection: {
        ...fresh, ...feed, participant: name,
        location: square.location, now: square.clock(), automaticDeliveryAvailable: hasAutomaticDeliveryIdentity(square.env),
        ...(entry.activity === null ? {} : { reentry: entry.activity }),
        ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
      },
    };
  } catch (error) {
    if (result === undefined && error instanceof Error && 'operation' in error) throw error;
    throw failure(error, {
      operation: 'express', participant: name, subject: 'caller',
      expressEffect: result === undefined ? 'unsent' : 'landed',
      ...(result === undefined ? {} : { landedId: result.activity.id }),
    });
  }
}

interface CatchCompletion {
  readonly data: CatchApplicationData;
  readonly participant: string;
  readonly stop?: CatchStopStatus;
  readonly waitStarted: boolean;
  readonly replaced: boolean;
  readonly observation: CatchSelectionObservation;
}

/** Leases, quiet waiting, selection and sweep form one lifecycle for both APIs. */
async function catchOwned(square: OpenSquare, requested: string, options: CatchApplicationOptions = {}, control?: OperationControl): Promise<CatchCompletion> {
  let name = requested, subject: 'caller' | 'filter' = 'caller';
  let leaseId: string | undefined;
  let waitStarted = false, replaced = false;
  let selection = options;
  const idle = options.idle ?? 0;
  async function complete(data: import('./square-actions.js').CatchSelectionResult | undefined, stop?: CatchStopStatus): Promise<CatchCompletion> {
    const selected = data ?? (await square.artifact.read((facts) => {
      const cursor = readCursor(facts, name);
      return {
        activities: [], consumedThrough: cursor < 0 ? null : formatActivityId(cursor),
        idleExpired: stop === 'stale',
        remaining: facts.directedCount(name, {
          unseenOnly: true, senders: selection.from,
          ...(selection.mention === true ? { attentionOnly: true } : {}),
        }),
        observation: {
          activities: [], sayNumbers: {}, now: square.clock(),
          standingCount: inSquareCount(facts), held: facts.hold().active,
          ownActivityCount: facts.participant(name)!.sayCount, hardCap: facts.header().hardCap,
          terminalStatus: watchTerminalStatus(facts, name),
        },
      };
    })).value;
    const { observation, ...caught } = selected;
    const terminal = stop === 'empty-now' || stop === undefined ? observation.terminalStatus ?? stop : stop;
    if (leaseId !== undefined) {
      await releaseWatchLease(square, name, leaseId).catch(() => undefined);
      leaseId = undefined;
    }
    if (!control?.signal?.aborted && stop !== 'replaced' && stop !== 'already-active'
      && (waitStarted || caught.activities.length > 0) && square.location !== 'memory'
      && square.hostLedger !== undefined && square.env?.SQUARE_DISABLE_PASEO_WAKE !== '1') {
      try {
        await sweepPending({
          artifact: square.artifact, hostLedger: square.hostLedger, location: square.location,
          now: square.clock(), graceMs: wakeGraceMs(square.env), limit: 8,
        });
      } catch { /* a completed receipt is not conditional on notification enrichment */ }
    }
    const status = terminal === 'already-active' || terminal === 'replaced' || terminal === 'capped' || terminal === 'quorum'
      ? terminal : undefined;
    return {
      data: { ...caught, ...(status === undefined ? {} : { status }) }, participant: name,
      ...(terminal === undefined ? {} : { stop: terminal }), waitStarted, replaced, observation,
    };
  }
  const empty = (stop: CatchStopStatus) => complete(undefined, stop);
  try {
    checkControl(control);
    if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
    if (options.id !== undefined
      && ['idle', 'from', 'mention', 'limit', 'replace'].some((key) => Object.hasOwn(options, key))) {
      throw new SquareError('invalid_args', 'Catch id cannot be combined with idle, from, mention, limit or replace');
    }
    if (Object.hasOwn(options, 'replace') && idle === 0) throw new SquareError('invalid_args', 'Catch replacement requires a positive idle duration');
    catchLimit(options.limit);
    name = (await resolveParticipant(square, requested, control)).name;
    subject = 'filter';
    const from = options.from === undefined ? undefined : await Promise.all(options.from.map(async (target) => (await resolveParticipant(square, target, control)).name));
    selection = { ...options, ...(from === undefined ? {} : { from }) };
    subject = 'caller';
    if (idle === 0) {
      const data = await catchUp(square, name, selection, control);
      return await complete(data, data.activities.length === 0 ? 'empty-now' : undefined);
    }
    if (!await assertLiveOwner(square, name)) {
      throw new SquareError('already_joined', `${name} already stands here — another session holds the name`);
    }
    const watch: WatchOptions = {
      ...(from === undefined ? {} : { participants: [...from] }),
      ...(options.mention ? { mention: name } : {}),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
    };
    const start = await acquireWatchLease(square, name, crypto.randomUUID(), watch, control?.signal);
    if (start.type === 'active') return await empty('already-active');
    leaseId = start.leaseId;
    waitStarted = true;
    replaced = start.replaced;
    control?.onProgress?.({
      kind: 'catch-started', participant: name, idleMs: idle,
      replacementRequested: options.replace ?? false, replaced,
    });
    let quietSince = square.clock();
    let wasHeld = false;
    let nextHeartbeat = start.heartbeatAt + WATCH_HEARTBEAT_MS;
    while (true) {
      checkControl(control);
      // Capture before evaluation: commits during selection cannot be missed.
      const baseline = await square.artifact.revision(control?.signal);
      const pulse = await pulseWatchLease(square, name, leaseId, watch, square.clock() >= nextHeartbeat, control?.signal);
      if (pulse.type === 'replaced') return await empty('replaced');
      if (pulse.type === 'terminal') return await empty(pulse.status);
      if (pulse.heartbeatAt !== undefined) nextHeartbeat = pulse.heartbeatAt + WATCH_HEARTBEAT_MS;
      if (pulse.type === 'sleep') {
        const caught = await catchUp(square, name, selection, control, leaseId);
        if (caught === null) return await empty('replaced');
        if (caught.activities.length > 0) return await complete(caught);
      }
      if (pulse.type === 'held' || wasHeld) quietSince = square.clock();
      wasHeld = pulse.type === 'held';
      if (!wasHeld && square.clock() - quietSince >= idle) {
        const owns = await ownsWatchLease(square, name, leaseId, control?.signal);
        return await empty(owns ? 'stale' : 'replaced');
      }
      const deadline = Math.min(nextHeartbeat, wasHeld ? Infinity : quietSince + idle);
      await square.artifact.changed(baseline, Math.max(0, deadline - square.clock()), control?.signal);
    }
  } catch (error) {
    throw failure(error, { operation: 'catch', subject, participant: name });
  } finally {
    // Cleanup deliberately does not reuse the aborted request signal, and the ID
    // fence never releases a replacement lease.
    if (leaseId !== undefined) await releaseWatchLease(square, name, leaseId).catch(() => undefined);
  }
}

class ParticipantHandle implements Participant {
  constructor(readonly name: string, private readonly square: OpenSquare, private readonly transport: () => Promise<WakeTransportPort | undefined>) {}
  async express(body: string, options?: ExpressOptions, control?: OperationControl): Promise<ExpressResult> {
    const entry = await prepareExpression(this.square, this.name, control);
    const { waited: _waited, observation: _observation, ...result } = await landExpression(
      this.square, entry.participant, body, { ...options, noWait: true }, this.transport, control,
    );
    return result;
  }
  listen(target: string, control?: OperationControl): Promise<ListenerChangeResult> { return listen(this.square, this.name, target, control); }
  ignore(target: string, control?: OperationControl): Promise<ListenerChangeResult> { return ignore(this.square, this.name, target, control); }
  listening(control?: OperationControl): Promise<readonly string[]> { return listening(this.square, this.name, control); }
  async catch(options?: CatchApplicationOptions, control?: OperationControl): Promise<CatchResult> {
    const { data } = await catchOwned(this.square, this.name, options, control);
    return { activities: data.activities, consumedThrough: data.consumedThrough, idleExpired: data.idleExpired, remaining: data.remaining };
  }
  history(query?: HistoryQuery, control?: OperationControl): Promise<Activity[]> { return participantHistory(this.square, this.name, query, control); }
  hold(reason?: string, control?: OperationControl): Promise<ExpressResult> { return hold(this.square, this.name, reason, control); }
  resume(control?: OperationControl): Promise<ExpressResult> { return resume(this.square, this.name, control); }
  done(body?: string, control?: OperationControl): Promise<ExpressResult> { return done(this.square, this.name, body, {}, control); }
}

/** Supported SDK resource. It owns one open artifact; application operations use
 * the same owner functions directly, not an application -> SDK -> application chain. */
export class Square {
  private readonly transport: () => Promise<WakeTransportPort | undefined>;
  private constructor(readonly location: string, private readonly square: OpenSquare) {
    this.transport = defaultTransport(square, location === 'memory');
  }
  static async at(input: SquareAtInput, control?: OperationControl): Promise<Square> {
    const env = { ...(input.env ?? process.env) };
    return new Square(input.path, await openSquare(input.path, { ...input, env, clock: clockFor(env, input.clock) }, control));
  }
  static async build(input: SquareBuildInput): Promise<Square> {
    const env = { ...(input.env ?? process.env) };
    return new Square(input.path, await buildSquare(input.path, { ...input, env, clock: clockFor(env, input.clock) }));
  }
  static inMemory(input: Omit<SquareBuildInput, 'path'>): Square { return new Square('memory', buildMemorySquare(input)); }
  private handle(name: string): Participant { return new ParticipantHandle(name, this.square, this.transport); }
  async join(name: string, control?: OperationControl): Promise<Participant> { return this.handle((await join(this.square, name, control)).name); }
  async takeover(name: string, control?: OperationControl): Promise<Participant> {
    const result = await takeover(this.square, name, [], control);
    return this.handle(result.name);
  }
  doneOwnedSession(name: string, body: string, expectedEpoch: number, control?: OperationControl): Promise<ExpressResult> { return done(this.square, name, body, { expectedEpoch }, control); }
  async implicitJoin(name: string, control?: OperationControl): Promise<{ readonly state: 'joined' | 'active' | 'done'; readonly participant?: Participant }> {
    const result = await implicitJoin(this.square, name, control);
    return { state: result.state, ...(result.state === 'done' ? {} : { participant: this.handle(result.name) }) };
  }
  participants(): Promise<ParticipantStatus[]> { return participants(this.square); }
  snapshot(control?: OperationControl): Promise<SquareSnapshot> { return snapshot(this.square, control); }
  history(query?: HistoryQuery, control?: OperationControl): Promise<Activity[]> { return history(this.square, query, control); }
  async recognize(env: NodeJS.ProcessEnv): Promise<Participant | null> {
    if (this.square.hostLedger === undefined) return null;
    const candidates = (await Promise.all(sessionIdsFromEnvironment(env).map((sessionId) =>
      projectSessionBindings({ hostLedger: this.square.hostLedger!, location: this.location, sessionId }),
    ))).flat();
    if (candidates.length !== 1) return null;
    const name = await currentParticipant(this.square, candidates[0].participant);
    return name === undefined ? null : this.handle(name);
  }
  close(): Promise<void> { return closeOpenSquare(this.square); }
  endOwnedSession(name: string, sessionId: string, expectedEpoch?: number) { return endOwnedSession(this.square, name, sessionId, expectedEpoch); }
  retireEndedSessionRoutes(sessionId: string): Promise<void> { return retireEndedSessionRoutes(this.square, sessionId); }
}

export function createSquareApplication(context: SquareApplicationContext): SquareApplication {
  const env = { ...context.env };
  const clock = clockFor(env, context.clock);
  const hostLedger = context.hostLedger ?? hostLedgerForEnv(env);
  const openOptions = { env, clock, hostLedger, wakeTransport: context.wakeTransport };
  const getTransport = defaultTransport(openOptions);
  function location(): string {
    const selected = context.squarePath ?? env.SQUARE_LOCATION;
    if (selected === undefined || selected.trim() === '') throw new SquareError('invalid_args', 'Square application context needs a square location');
    return path.resolve(context.cwd, selected);
  }
  async function actor(): Promise<string> {
    const selected = context.participant ?? env.SQUARE_PARTICIPANT_NAME;
    if (context.participant !== undefined || selected?.trim()) {
      validateName(selected!);
      return selected!;
    }
    const discovered = await localParticipantName(location(), hostLedger, env);
    if (discovered !== undefined) return discovered;
    throw new SquareError('invalid_args', 'Square application context needs one unambiguous participant name');
  }
  async function scoped<T>(operation: (square: OpenSquare) => Promise<T>, control?: OperationControl): Promise<T> {
    checkControl(control);
    const square = await openSquare(location(), openOptions, control);
    try { return await operation(square); }
    finally { await closeOpenSquare(square).catch(() => undefined); }
  }
  async function selected<T>(
    operation: ApplicationFailureDetail['operation'],
    run: (square: OpenSquare, name: string) => Promise<T>, control?: OperationControl,
  ): Promise<T> {
    let name = context.participant ?? env.SQUARE_PARTICIPANT_NAME;
    try {
      checkControl(control);
      name = await actor();
      return await scoped((square) => run(square, name!), control);
    } catch (error) {
      const detail = (error as import('./square-facade.js').ApplicationError)?.operation;
      if (detail?.operation === operation) throw error;
      throw failure(error, {
        operation, participant: detail?.participant ?? name, subject: 'caller',
        ...(operation === 'express' ? { expressEffect: 'unsent' as const } : {}),
      });
    }
  }
  async function listener(verb: 'listen' | 'ignore', target: string, control?: OperationControl) {
    return selected('other', async (square, requested) => {
      const name = (await resolveParticipant(square, requested, control)).name;
      const result = await (verb === 'listen' ? listen : ignore)(square, name, target, control);
      return {
        data: result,
        projection: {
          ...await contextProjection(square, name), participant: name,
          requestedTarget: target, target: result.activity?.target ?? target,
        },
      };
    }, control);
  }
  async function lifecycle(verb: 'done' | 'hold' | 'resume', body: string | undefined, control?: OperationControl) {
    if (verb === 'done') validateDoneBody(body);
    return selected('other', async (square, requested) => {
      const identity = localSessionIdentities(env)[0];
      const owner = verb !== 'done' || identity === undefined ? undefined : await readParticipantOwner(square.location, requested, hostLedger);
      const fenced = identity !== undefined && owner?.session === identity.sessionId && presenceEpoch(owner) > 0;
      const name = fenced ? requested : (await join(square, requested, control)).name;
      let result: ExpressResult;
      if (verb === 'done') {
        const fence = fenced ? { expectedEpoch: presenceEpoch(owner) } : {};
        result = await done(square, name, body ?? '', fence, control);
      } else if (verb === 'hold') {
        result = await hold(square, name, body, control);
      } else {
        result = await resume(square, name, control);
      }
      const view = await eventPresentation(square, result.activity.id);
      return {
        data: { activity: result.activity },
        projection: { ...observedContext(square, view.participantCount, view.held, name), ...view },
      };
    }, control);
  }
  return {
    now: clock,
    async build(input, control) {
      checkControl(control);
      const squarePath = location();
      const now = clock();
      const hardCap = input.hardCap ?? null;
      if (hardCap !== null && (!Number.isSafeInteger(hardCap) || hardCap < 1)) {
        throw new SquareError('invalid_args', 'hardCap must be a positive integer or null');
      }
      if (input.throttlePerMinute !== undefined
        && (!Number.isSafeInteger(input.throttlePerMinute) || input.throttlePerMinute < 1)) {
        throw new SquareError('invalid_args', 'throttlePerMinute must be a positive integer');
      }
      await createSquare(squarePath, {
        hardCap, throttlePerMinute: input.throttlePerMinute,
        template: input.template, force: input.force ?? false,
      }, input.markdown, control?.signal);
      return {
        data: { location: squarePath, hardCap,
          ...(input.throttlePerMinute === undefined ? {} : { throttlePerMinute: input.throttlePerMinute }) },
        projection: { location: squarePath, standingCount: 0, held: false, now,
          automaticDeliveryAvailable: hasAutomaticDeliveryIdentity(env) },
      };
    },
    join(options = {}, control) {
      return selected('join', async (square, name) => {
        const last = options.last ?? 10;
        if (!Number.isSafeInteger(last) || last < 1 || last > 100) {
          throw new SquareError('invalid_args', 'Join history limit must be between 1 and 100');
        }
        const data = await joinOwned(square, name, options, control);
        try {
          const view = await entryPresentation(square, data.participant, last);
          return {
            data,
            projection: { ...observedContext(square, view.participantCount, view.held, data.participant), ...view },
          };
        } catch (error) {
          throw failure(error, { operation: 'join', participant: data.participant, subject: 'caller' });
        }
      }, control);
    },
    express(body, options = {}, control) {
      return selected('express', (square, name) => expressOwned(square, name, body, options, getTransport, control), control);
    },
    catch(options, control) {
      return selected('catch', async (square, name) => {
        const result = await catchOwned(square, name, options, control);
        const presence = await catchPresence(square, control).catch(() => undefined);
        const view = result.observation;
        return {
          data: result.data,
          projection: {
            ...observedContext(square, view.standingCount, view.held, result.participant, view.now),
            ...view, participant: result.participant, stop: result.stop,
            ...(presence === undefined ? { enrichmentUnavailable: true as const } : { presence }),
            waitStarted: result.waitStarted, replaced: result.replaced,
          },
        };
      }, control);
    },
    history(query, control) {
      return scoped(async (square) => {
        const { data, projection } = await applicationHistory(square, query, control);
        return {
          data,
          projection: { ...observedContext(square, projection.participantCount, projection.held), ...projection },
        };
      }, control);
    },
    listen: (target, control) => listener('listen', target, control),
    ignore: (target, control) => listener('ignore', target, control),
    listening(control) {
      return selected('other', async (square, requested) => {
        const name = (await resolveParticipant(square, requested, control)).name;
        const targets = await listening(square, name, control);
        return { data: { listening: targets }, projection: await contextProjection(square, name, control) };
      }, control);
    },
    hold: (reason, control) => lifecycle('hold', reason, control),
    resume: (control) => lifecycle('resume', undefined, control),
    done: (body, control) => lifecycle('done', body, control),
    async status(viewer, control) {
      checkControl(control);
      const selectedViewer = viewer ?? await actor().catch(() => '');
      return scoped(async (square) => {
        const projection = await statusPresentation(square, selectedViewer, control);
        const status = projection.status;
        const latest = status.latestAct;
        return {
          data: {
            hardCap: status.hardCap,
            ...(status.throttlePerMinute === undefined ? {} : { throttlePerMinute: status.throttlePerMinute }),
            activeCount: status.activeCount, doneCount: status.doneCount,
            hold: status.holdActive ? {
              ...(status.holdActor === undefined ? {} : { by: status.holdActor }),
              ...(status.holdReason === undefined ? {} : { reason: status.holdReason }),
              ...(status.holdAt === undefined ? {} : { at: status.holdAt }),
            } : null,
            participants: status.participants.filter((p) => p.state !== 'not joined'),
            ...(latest === undefined || latest.actor === undefined || latest.kind === 'read'
              ? {} : { latestActivity: toPublicActivity(latest) }),
            now: status.now,
          },
          projection: {
            ...observedContext(square, status.activeCount, status.holdActive, projection.viewer || undefined, status.now),
            ...projection,
          },
        };
      }, control);
    },
    participants(control) {
      return scoped(async (square) => {
        const result = await participantsPresentation(square, control);
        return {
          data: { participants: result.participants },
          projection: { ...observedContext(square, result.standingCount, result.held, undefined, result.now), ...result },
        };
      }, control);
    },
    async diagnose(control) {
      checkControl(control);
      const squarePath = location();
      const data = await diagnoseSquareFile(squarePath);
      return {
        data,
        projection: { location: squarePath, now: clock(),
          ...(data.standingCount === undefined ? {} : { standingCount: data.standingCount }) },
      };
    },
    async migrate(control) {
      checkControl(control);
      const squarePath = location();
      const data = await migrateSquareFile(squarePath, control?.signal);
      return { data, projection: { location: squarePath, now: clock(), standingCount: data.standing } };
    },
    async discover(options, control) {
      checkControl(control);
      const data = await discoverSquares(context.cwd, options, control, openOptions);
      return {
        data,
        projection: { cwd: context.cwd, now: clock(),
          depth: options.depth ?? DEFAULT_LIST_DEPTH, limit: options.limit ?? DEFAULT_LIST_LIMIT },
      };
    },
    async inbox(sessionId, options = {}, control) {
      checkControl(control);
      const limit = options.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SquareError('invalid_args', 'Inbox limit must be between 1 and 100');
      const rows: { name: string; squarePath: string; pending: number }[] = [];
      for (const binding of await projectSessionBindings({ hostLedger, sessionId })) {
        checkControl(control);
        let square: OpenSquare | undefined;
        try {
          square = await openSquare(binding.location, openOptions, control);
          const row = (await square.artifact.read((facts) => {
            const participant = facts.participant(binding.participant);
            if (!participant?.joined) return undefined;
            return {
              name: participant.name, squarePath: binding.location,
              pending: facts.directedCount(participant.name, { unseenOnly: true }),
            };
          }, control?.signal)).value;
          if (row !== undefined) rows.push(row);
        } catch (error) { if (control?.signal?.aborted) throw error; }
        finally { if (square !== undefined) await closeOpenSquare(square); }
      }
      rows.sort((a, b) => {
        const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
        return compare(a.squarePath, b.squarePath) || compare(nameKey(a.name), nameKey(b.name)) || compare(a.name, b.name);
      });
      return { data: { rows: rows.slice(0, limit), total: rows.length }, projection: { sessionId, now: clock(), limit } };
    },
    async recovery(control) {
      let projection: import('./square-facade.js').RecoveryProjection = { now: clock() };
      try {
        projection = { ...projection, location: location() };
        const name = await actor().catch(() => undefined);
        if (name !== undefined) projection = { ...projection, participant: name };
        await scoped(async (square) => {
          if (name === undefined) {
            projection = { ...projection, ...await contextProjection(square, undefined, control) };
          } else {
            const facts = await recoveryObservation(square, name, control).catch(() => undefined);
            projection = facts === undefined
              ? { ...projection, ...await contextProjection(square, name, control) }
              : {
                ...projection, ...observedContext(square, facts.participantCount, facts.held, facts.name),
                holdReason: facts.holdReason, ownActivityCount: facts.ownActivityCount,
                hardCap: facts.hardCap, roster: facts.roster, activitySummaries: facts.activitySummaries,
              };
          }
        }, control);
      } catch { /* unavailable recovery observations never replace the original error */ }
      return { data: projection, projection };
    },
    stream(options, control) {
      checkControl(control);
      return streamSquare(location(), options, control, openOptions);
    },
  };
}
