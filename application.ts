import { randomUUID } from 'node:crypto';
import { extractMentions, formatActivityId, parseActivityId, type Act, type ActivityId } from './square-core.js';
import { coreDone, coreHold, coreIgnore, coreListen, coreListening, coreResume, decideAct, decideImplicitJoin, decideJoin } from './decisions.js';
import { SquareError, nameKey, type InboxNotification, type SquareState, type StoredAct } from './model.js';
import { participantIdentity } from './participant-identity.js';
import type { HostLedgerPort, PresenceChannel, PresenceRecord, SquareArtifactPort } from './ports.js';
import type { Activity, ExpressOptions, ExpressResult } from './square-facade.js';
import { decideCatch, type CatchDecision, type CatchProjection } from './catch-decisions.js';
import type { CatchOptions, CatchResult, PerceivedActivity } from './square-facade.js';
import { deriveDeliveryModel } from './delivery.js';
import { freshWatchLease, recordObservation } from './runtime.js';
import type {
  DeliveryResult,
  DeliverPendingInput,
  ObserveSquareInput,
  PresentPendingInput,
  PresentationResult,
  ReconcileBindingInput,
  SquareObservation,
  PresentationProjection,
  PresentationEvidenceProjection,
  SessionBindingProjection,
} from './ports.js';
import type { WakeRoute } from './model.js';

/** Application projection of one host-owned wake evidence row. */
export interface WakeAttempt {
  readonly at: number;
  readonly attention: { readonly squarePath: string; readonly actIndex: number; readonly recipient: string };
  readonly routeKind: import('./model.js').WakeRouteKind;
  readonly outcome: 'accepted' | 'unknown' | 'failed';
  readonly signature?: string;
  readonly attemptN: number;
  readonly session?: string;
  readonly message?: string;
  readonly diagnostic?: unknown;
}

/** Pure wake eligibility over host-ledger attempt rows. */
export function terminalWakeEvidence(attempts: readonly WakeAttempt[]): WakeAttempt | undefined {
  return attempts.findLast((attempt) => attempt.outcome === 'accepted');
}
export function isWakeRouteAttemptable(route: Pick<WakeRoute, 'kind' | 'updatedAt'>, attempts: readonly WakeAttempt[]): boolean {
  if (terminalWakeEvidence(attempts) !== undefined) return false;
  const failed = attempts.findLast((attempt) => attempt.routeKind === route.kind && attempt.outcome === 'failed');
  return failed === undefined || route.updatedAt > failed.at;
}
export function hasAttemptableWakeRoute(routes: readonly Pick<WakeRoute, 'kind' | 'updatedAt'>[], attempts: readonly WakeAttempt[]): boolean {
  return routes.some((route) => isWakeRouteAttemptable(route, attempts));
}

export interface OperationContext {
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly location?: string;
  readonly hostLedger?: HostLedgerPort;
  readonly env?: NodeJS.ProcessEnv;
}
export interface JoinInput { readonly name: string }
export interface ExpressInput { readonly name: string; readonly body: string; readonly options?: ExpressOptions }
export interface ListenInput { readonly name: string; readonly target: string }
export interface IgnoreInput extends ListenInput {}
export interface DoneInput { readonly name: string; readonly body?: string }
export interface HoldInput extends DoneInput {}
export interface ResumeInput { readonly name: string }
export interface CatchInput { readonly name: string; readonly options?: CatchOptions }
export type CommittedActivity = Activity;
export interface NoopJoin { readonly name: string; readonly activity: null }
export interface NoopListenerChange { readonly activity: null }
export type CatchOutcome = CatchResult;

function bindingProjection(record: PresenceRecord): SessionBindingProjection {
  return {
    location: record.location,
    participant: record.participant,
    sessionId: record.session,
    channel: record.channel,
    ...(record.route === undefined ? {} : {
      route: {
        location: record.location,
        participant: record.participant,
        sessionId: record.session,
        channel: record.channel,
        kind: record.route.kind,
        address: { ...record.route.address },
        updatedAt: record.updatedAt ?? 0,
      },
    }),
    updatedAt: record.updatedAt ?? 0,
  };
}

/** Project host-owned bindings without exposing ledger row shape to consumers. */
export async function projectSessionBindings(input: {
  readonly hostLedger: HostLedgerPort;
  readonly sessionId: string;
  readonly location?: string;
  readonly scopes?: readonly import('./host-ledger.js').HostLedgerScope[];
  readonly now?: number;
}): Promise<readonly SessionBindingProjection[]> {
  const rows = await input.hostLedger.listPresence({
    location: input.location,
    session: input.sessionId,
    scopes: input.scopes ?? ['user', 'local'],
    now: input.now,
  });
  return rows.map(bindingProjection);
}

/** Session identities exposed by native executor environments. */
export function sessionIdsFromEnvironment(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID, env.OPENCODE_SESSION_ID, env.SQUARE_PI_SESSION_ID, env.PASEO_AGENT_ID]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

/** Project the locally owned binding for one participant without registry access. */
export async function projectLocalParticipantBinding(input: {
  readonly hostLedger: HostLedgerPort;
  readonly location: string;
  readonly participant: string;
  readonly sessionIds: readonly string[];
  readonly now?: number;
}): Promise<SessionBindingProjection | undefined> {
  const bindings = (await Promise.all(input.sessionIds.map((sessionId) => projectSessionBindings({
    hostLedger: input.hostLedger,
    location: input.location,
    sessionId,
    scopes: ['user', 'local'],
    now: input.now,
  })))).flat();
  return bindings.find((binding) => binding.participant.toLocaleLowerCase() === input.participant.toLocaleLowerCase());
}

/** Project one session binding's pending presentation from the authoritative artifact. */
export async function projectPresentation(input: {
  readonly artifact: SquareArtifactPort;
  readonly binding: SessionBindingProjection;
  readonly now?: number;
}): Promise<PresentationProjection> {
  const { state } = await input.artifact.read();
  const delivery = deriveDeliveryModel(state);
  const known = delivery.knownParticipant(input.binding.participant);
  if (known === undefined || !delivery.joinedRecipients().some((recipient) => recipient.toLocaleLowerCase() === known.toLocaleLowerCase())) {
    return { binding: input.binding, joined: false, notifications: [] };
  }
  const binding = input.binding.participant === known
    ? input.binding
    : { ...input.binding, participant: known };
  const notifications: InboxNotification[] = delivery.pendingFor(known).map(({ item, route }) => ({
    actIndex: item.index,
    actor: item.actor,
    at: item.at,
    route,
    body: item.body,
  }));
  const lease = freshWatchLease(state, known, input.now ?? Date.now());
  return {
    binding,
    joined: true,
    notifications,
    ...(lease === undefined ? {} : { catchLease: lease }),
  };
}

/** Project host-owned presentation evidence without leaking ledger rows. */
export async function projectPresentationEvidence(input: {
  readonly hostLedger: HostLedgerPort;
  readonly location?: string;
  readonly participant?: string;
  readonly sessionId?: string;
  readonly activity?: string;
  readonly now?: number;
}): Promise<readonly PresentationEvidenceProjection[]> {
  const rows = await input.hostLedger.listEvidence({
    kind: 'presentation',
    location: input.location,
    participant: input.participant,
    session: input.sessionId,
    activity: input.activity,
    now: input.now,
  });
  return rows.map((row) => ({
    location: row.location,
    participant: row.participant,
    sessionId: row.session,
    activity: row.activity,
    outcome: row.outcome,
    ...(row.at === undefined ? {} : { at: row.at }),
  }));
}

export interface ApplicationWakeEvidence {
  readonly delivered: boolean;
  readonly presented: boolean;
  readonly attempts: readonly WakeAttempt[];
  readonly terminal?: WakeAttempt;
  readonly attemptableRoutes: readonly WakeRoute[];
}

export interface ApplicationWakeEvidenceProjection {
  evidence(recipient: string, actIndex: number): ApplicationWakeEvidence;
}

/** Project wake and presentation evidence from one artifact snapshot and host-owned rows. */
export async function projectWakeEvidenceFromState(input: {
  readonly location: string;
  readonly state: SquareState;
  readonly hostLedger: HostLedgerPort;
  readonly now: number;
  readonly delivery?: ReturnType<typeof deriveDeliveryModel>;
}): Promise<ApplicationWakeEvidenceProjection> {
  const canonicalPath = input.location;
  const delivery = input.delivery ?? deriveDeliveryModel(input.state);
  const bindings = (await input.hostLedger.listPresence({ location: canonicalPath, scopes: ['user'], now: input.now })).map(bindingProjection);
  const wakeRecords = await input.hostLedger.listEvidence({ location: canonicalPath, kind: 'wake', now: input.now });
  const attemptsByBinding = new Map<string, WakeAttempt[]>();
  for (const record of wakeRecords) {
    const actIndex = parseActivityId(record.activity);
    if (actIndex === undefined || record.routeKind === undefined || typeof record.attemptN !== 'number') continue;
    const attempt: WakeAttempt = {
      attention: { squarePath: record.location, recipient: record.participant, actIndex },
      outcome: record.outcome as WakeAttempt['outcome'],
      at: record.at ?? input.now,
      routeKind: record.routeKind,
      attemptN: record.attemptN,
      ...(record.signature === undefined ? {} : { signature: record.signature }),
      ...(record.session === undefined ? {} : { session: record.session }),
      ...(record.message === undefined ? {} : { message: record.message }),
      ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }),
    };
    const key = JSON.stringify([nameKey(record.participant), actIndex, record.session]);
    const existing = attemptsByBinding.get(key) ?? [];
    existing.push(attempt);
    attemptsByBinding.set(key, existing);
  }
  const presentedRows = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: canonicalPath, now: input.now });
  return {
    evidence(recipient: string, actIndex: number): ApplicationWakeEvidence {
      const recipientBindings = bindings.filter((binding) => nameKey(binding.participant) === nameKey(recipient));
      const routes = recipientBindings.flatMap((binding) => binding.route === undefined ? [] : [binding.route]);
      const attempts = recipientBindings.flatMap((binding) => attemptsByBinding.get(JSON.stringify([nameKey(recipient), actIndex, binding.sessionId])) ?? []);
      const terminal = terminalWakeEvidence(attempts);
      const presented = presentedRows.some((row) => row.activity === formatActivityId(actIndex)
        && row.participant.toLocaleLowerCase() === recipient.toLocaleLowerCase()
        && recipientBindings.some((binding) => binding.sessionId === row.sessionId));
      return {
        delivered: delivery.isSeen(recipient, actIndex),
        presented,
        attempts,
        ...(terminal === undefined ? {} : { terminal }),
        attemptableRoutes: terminal === undefined ? routes.filter((route) => isWakeRouteAttemptable(route, attempts)) : [],
      };
    },
  };
}

export function wakeIsEligible(evidence: ApplicationWakeEvidence): boolean {
  return !evidence.delivered && evidence.terminal === undefined && evidence.attemptableRoutes.length > 0;
}

/** Read-only projection used by every privileged executor. */
export async function observeSquare(input: ObserveSquareInput): Promise<SquareObservation> {
  const snapshot = await input.artifact.read();
  const delivery = deriveDeliveryModel(snapshot.state);
  const rows = input.hostLedger === undefined
    ? []
    : await input.hostLedger.listPresence({ location: input.location, scopes: ['user', 'local'], now: input.now });
  const bindings = rows.map(bindingProjection);
  return {
    ...(input.location === undefined ? {} : { location: input.location }),
    version: snapshot.version,
    state: snapshot.state,
    pending: delivery.joinedRecipients().map((recipient) => ({ recipient, notifications: delivery.pendingFor(recipient) })),
    bindings,
  };
}

/** Make host discovery agree with one artifact without mutating the artifact. */
export async function reconcileBinding(input: ReconcileBindingInput) {
  return input.hostLedger.reconcileBinding({
    artifact: input.artifact,
    scopes: input.scopes,
    now: input.now,
  });
}

/** Deliver a frozen pending projection through a caller-supplied transport. */
export async function deliverPending(input: DeliverPendingInput): Promise<DeliveryResult> {
  const observation = await observeSquare({ artifact: input.artifact, hostLedger: input.hostLedger, location: input.location, now: input.now });
  const routes = (await input.hostLedger.listPresence({ location: input.location, scopes: ['user'], now: input.now }))
    .filter((binding) => binding.route !== undefined);
  let attempted = 0; let accepted = 0; let failed = 0; let unknown = 0;
  for (const membership of observation.pending) {
    for (const notification of membership.notifications) {
      const candidates = routes.filter((route) => route.participant.toLocaleLowerCase() === membership.recipient.toLocaleLowerCase());
      if (input.activity !== undefined) {
        const requested = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
        if (requested === undefined || requested !== notification.item.index) continue;
      }
      for (const route of candidates) {
        const activity = formatActivityId(notification.item.index);
        const attention = { squarePath: input.location, actIndex: notification.item.index, recipient: membership.recipient };
        let leaseId = randomUUID();
        let lease = await input.hostLedger.claimWakeDispatch({ attention, leaseId, leaseMs: input.timeoutMs ?? 5000, session: route.session, at: input.now });
        if (lease.type === 'ambiguous') {
          await input.hostLedger.appendEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', outcome: 'unknown', routeKind: lease.lease.routeKind ?? route.route!.kind, attemptN: lease.lease.attemptN ?? 1, signature: 'worker_interrupted_during_dispatch', message: 'The notification worker ended after dispatch began; transport acceptance is unknown.', at: input.now });
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId: lease.lease.leaseId, session: route.session, at: input.now });
          leaseId = randomUUID();
          lease = await input.hostLedger.claimWakeDispatch({ attention, leaseId, leaseMs: input.timeoutMs ?? 5000, session: route.session, at: input.now });
        }
        if (lease.type !== 'acquired') continue;
        const attempts = await input.hostLedger.listWakeAttempts({
          attention,
          session: route.session,
          now: input.now,
        });
        const attemptN = attempts.reduce((highest, record) => Math.max(highest, record.attemptN ?? 0), 0) + 1;
        const request = { location: input.location, participant: membership.recipient, activity, route: {
          location: route.location, participant: route.participant, sessionId: route.session,
          channel: route.channel, kind: route.route!.kind, address: { ...route.route!.address }, updatedAt: route.updatedAt ?? 0,
        } };
        let outcome;
        const claim = await input.hostLedger.claimEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', leaseMs: input.timeoutMs ?? 5000, now: input.now });
        if (claim.status !== 'acquired') {
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now });
          continue;
        }
        attempted += 1;
        const dispatching = await input.hostLedger.transitionWakeDispatch({
          attention,
          leaseId,
          phase: 'dispatching',
          leaseMs: input.timeoutMs ?? 5000,
          routeKind: route.route!.kind,
          attemptN,
          session: route.session,
          at: input.now,
        });
        if (!dispatching) {
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now });
          continue;
        }
        try {
          outcome = await Promise.race([
            input.transport.attempt(request, input.timeoutMs ?? 5000),
            new Promise<import('./ports.js').WakeOutcome>((resolve) => setTimeout(() => resolve({ outcome: 'unknown', diagnostic: 'transport timeout' }), input.timeoutMs ?? 5000)),
          ]);
        } catch (error) {
          outcome = { outcome: 'unknown' as const, diagnostic: error instanceof Error ? error.message : String(error) };
        }
        if (outcome.outcome === 'failed' && outcome.unavailable) {
          await input.transport.invalidate?.(request);
          await input.hostLedger.releaseEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', now: input.now });
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now });
          failed += 1;
          continue;
        }
        await input.hostLedger.appendEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', outcome: outcome.outcome, routeKind: route.route!.kind, attemptN: outcome.attemptN ?? attemptN, ...(outcome.outcome === 'accepted' && outcome.signature === undefined ? {} : outcome.outcome === 'accepted' ? { signature: outcome.signature } : outcome.outcome === 'failed' ? { message: outcome.message } : { diagnostic: outcome.diagnostic }), at: input.now });
        await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now });
        if (outcome.outcome === 'accepted') accepted += 1;
        else if (outcome.outcome === 'failed') failed += 1;
        else unknown += 1;
      }
    }
  }
  return { attempted, accepted, failed, unknown };
}

/** Pure candidate selection from one artifact projection and host-ledger rows. */
export function selectPendingWakeActivities(
  state: SquareState,
  routes: readonly PresenceRecord[],
  attempts: readonly WakeAttempt[],
  now: number,
  graceMs: number,
  limit: number,
  delivery = deriveDeliveryModel(state),
): number[] {
  const selected = new Set<number>();
  for (const membership of delivery.joinedRecipients()) {
    for (const notification of delivery.pendingFor(membership)) {
      if (now - notification.item.at <= graceMs) continue;
      const eligible = routes.some((binding) => {
        if (binding.route === undefined || binding.participant.toLocaleLowerCase() !== membership.toLocaleLowerCase()) return false;
        const matching = attempts.filter((attempt) => attempt.session === binding.session && attempt.attention.squarePath === binding.location && attempt.attention.recipient.toLocaleLowerCase() === membership.toLocaleLowerCase() && attempt.attention.actIndex === notification.item.index);
        return isWakeRouteAttemptable({ kind: binding.route.kind, updatedAt: binding.updatedAt ?? 0 }, matching);
      });
      if (eligible) selected.add(notification.item.index);
    }
  }
  return [...selected].sort((left, right) => left - right).slice(0, Math.max(0, limit));
}

/** Read host rows once, then derive bounded sweep candidates without executor policy. */
export async function sweepPending(input: {
  readonly artifact: SquareArtifactPort;
  readonly hostLedger: HostLedgerPort;
  readonly location: string;
  readonly now: number;
  readonly graceMs: number;
  readonly limit: number;
}): Promise<number[]> {
  const { state } = await input.artifact.read();
  return sweepPendingFromState({ ...input, state });
}

/** Project host rows once for callers that already hold a frozen artifact state. */
export async function sweepPendingFromState(input: {
  readonly state: SquareState;
  readonly hostLedger: HostLedgerPort;
  readonly location: string;
  readonly now: number;
  readonly graceMs: number;
  readonly limit: number;
  readonly deriveDelivery?: (snapshot: SquareState) => ReturnType<typeof deriveDeliveryModel>;
}): Promise<number[]> {
  const [bindings, records] = await Promise.all([
    input.hostLedger.listPresence({ location: input.location, scopes: ['user'], now: input.now }),
    input.hostLedger.listWakeAttempts({ now: input.now }),
  ]);
  const attempts: WakeAttempt[] = records.flatMap((record) => {
    const index = parseActivityId(record.activity);
    if (index === undefined || record.routeKind === undefined || typeof record.attemptN !== 'number') return [];
    return [{ at: record.at ?? input.now, attention: { squarePath: record.location, actIndex: index, recipient: record.participant }, routeKind: record.routeKind, outcome: record.outcome as WakeAttempt['outcome'], attemptN: record.attemptN, ...(record.session === undefined ? {} : { session: record.session }) }];
  });
  const delivery = input.deriveDelivery?.(input.state) ?? deriveDeliveryModel(input.state);
  return selectPendingWakeActivities(input.state, bindings, attempts, input.now, input.graceMs, input.limit, delivery);
}

/** Present one pending activity, making artifact seen the authoritative receipt. */
export async function presentPending(input: PresentPendingInput): Promise<PresentationResult> {
  const index = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (index === undefined) return { presented: false };
  let before: Awaited<ReturnType<SquareArtifactPort['read']>>;
  try {
    before = await input.artifact.read();
  } catch {
    return { presented: false };
  }
  const delivery = deriveDeliveryModel(before.state);
  const item = before.state.acts.find((activity) => activity.index === index);
  if (item === undefined || delivery.isSeen(input.participant, index) || !delivery.pendingFor(input.participant).some((notification) => notification.item.index === index)) return { presented: false };
  if (input.hostLedger !== undefined && input.session !== undefined) {
    const claim = await input.hostLedger.claimEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', leaseMs: input.timeoutMs ?? 5000, now: input.now });
    if (claim.status !== 'acquired') return { presented: false };
    let current: Awaited<ReturnType<SquareArtifactPort['read']>>;
    try {
      current = await input.artifact.read();
    } catch {
      await input.hostLedger.releaseEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', now: input.now }).catch(() => undefined);
      return { presented: false };
    }
    if (deriveDeliveryModel(current.state).isSeen(input.participant, index)) {
      await input.hostLedger.releaseEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', now: input.now }).catch(() => undefined);
      return { presented: false };
    }
    try {
      await input.sink.present(item);
    } catch (error) {
      await input.hostLedger.appendEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', outcome: 'failed', message: error instanceof Error ? error.message : String(error), at: input.now });
      throw error;
    }
  } else {
    await input.sink.present(item);
  }
  if (input.markSeen !== false) {
    await input.artifact.transact((state) => {
      const changed = recordObservation(state, input.participant, index, 'seen', input.now ?? Date.now());
      return changed ? { state, result: undefined } : { result: undefined };
    });
  }
  if (input.hostLedger !== undefined && input.session !== undefined) {
    await input.hostLedger.appendEvidence({
      location: input.location,
      participant: input.participant,
      session: input.session,
      activity: formatActivityId(index),
      kind: 'presentation',
      outcome: input.markSeen === false ? 'clipped' : 'presented',
      ...(input.markSeen === false ? { message: 'presentation clipped' } : {}),
      at: input.now,
    });
  }
  return { presented: true, activity: item };
}

export class ActivityApplication {
  constructor(private readonly context: OperationContext) {}
  join(input: JoinInput) { return join(this.context, input.name); }
  implicitJoin(input: JoinInput) { return implicitJoin(this.context, input.name); }
  express(input: ExpressInput) { return express(this.context, input.name, input.body, input.options); }
  catch(input: CatchInput) { return catchUp(this.context, input.name, input.options); }
  listen(input: ListenInput) { return listen(this.context, input.name, input.target); }
  ignore(input: IgnoreInput) { return ignore(this.context, input.name, input.target); }
  done(input: DoneInput) { return done(this.context, input.name, input.body); }
  hold(input: HoldInput) { return hold(this.context, input.name, input.body); }
  resume(input: ResumeInput) { return resume(this.context, input.name); }
  listening(name: string) { return listening(this.context, name); }
}

function processIdentity(env: NodeJS.ProcessEnv): { session: string; channel: PresenceChannel } {
  const choices: readonly [string | undefined, PresenceChannel][] = [
    [env.CLAUDE_CODE_SESSION_ID, 'claude-code'], [env.CODEX_THREAD_ID, 'codex'],
    [env.OPENCODE_SESSION_ID, 'opencode'], [env.SQUARE_PI_SESSION_ID, 'pi'], [env.PASEO_AGENT_ID, 'paseo'],
  ];
  const found = choices.find(([session]) => session?.trim());
  return found === undefined ? { session: `process:${process.pid}`, channel: 'unknown' } : { session: found[0]!.trim(), channel: found[1] };
}

/** Host discovery is best effort and precedes every artifact mutation. */
async function ensureLocalPresence(context: OperationContext, participant: string): Promise<void> {
  if (context.hostLedger === undefined || context.location === undefined || context.location === 'memory') return;
  const identity = processIdentity(context.env ?? process.env);
  const result = await context.hostLedger.ensurePresence({
    location: context.location, participant, session: identity.session, channel: identity.channel, updatedAt: context.clock(),
  }, 'local').catch((error) => ({ status: 'degraded' as const, record: { location: context.location!, participant, session: identity.session, channel: identity.channel }, error }));
  if (result.status === 'degraded') process.stderr.write(`! host presence degraded: ${result.error instanceof Error ? result.error.message : String(result.error)}\n`);
}

function exposeCaught(activity: StoredAct, perception: 'full' | 'presence'): PerceivedActivity {
  if (activity.kind === 'read' || activity.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(activity.index)}`);
  const result = {
    id: formatActivityId(activity.index), at: activity.at, kind: activity.kind, actor: activity.actor,
    mentions: activity.kind === 'say' ? extractMentions(activity.body) : [],
    ...('body' in activity && activity.body !== undefined ? { body: activity.body } : {}),
    ...('target' in activity ? { target: activity.target } : {}),
    ...(activity.kind === 'say' && activity.reply !== undefined ? { reply: formatActivityId(activity.reply) } : {}),
  } as Activity;
  if (perception === 'full' || !('body' in result)) return { ...result, perception };
  const { body: _body, ...withoutBody } = result;
  return { ...withoutBody, perception };
}

export async function catchUp(
  square: OperationContext,
  name: string,
  options: CatchOptions = {},
  project?: (state: SquareState) => CatchProjection,
): Promise<CatchResult> {
  const idle = options.idle ?? 0;
  if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
  const deadline = Date.now() + idle;
  while (true) {
    const attempt = await square.artifact.transact<{ version: number; decision: CatchDecision }>((state, version) => {
      const decision = decideCatch(state, name, options, square.clock(), project);
      return { ...(decision.changed ? { state } : {}), result: { version, decision } };
    });
    await ensureLocalPresence(square, name);
    if (attempt.decision.delivered.length > 0 || idle === 0) {
      return {
        activities: attempt.decision.delivered.map((activity) => exposeCaught(activity, attempt.decision.perceptions.get(activity.index) ?? 'full')),
        consumedThrough: attempt.decision.consumedThrough as CatchResult['consumedThrough'],
        idleExpired: false,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !await square.artifact.changed(attempt.version, remaining)) {
      return { activities: [], consumedThrough: attempt.decision.consumedThrough as CatchResult['consumedThrough'], idleExpired: true };
    }
  }
}

function storeActs(state: SquareState, acts: readonly Act[]): StoredAct[] {
  const stored: StoredAct[] = [];
  for (const act of acts) {
    const item = { ...act, index: state.runtime.nextActIndex } as StoredAct;
    state.runtime.nextActIndex += 1;
    state.acts.push(item);
    stored.push(item);
  }
  return stored;
}

function committedActivity(stored: readonly StoredAct[], verb: string): StoredAct {
  const activity = stored[0];
  if (activity === undefined) throw new Error(`${verb} activity did not commit`);
  return activity;
}

function exposeActivity(stored: StoredAct): Activity {
  if (stored.kind === 'read' || stored.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(stored.index)}`);
  return {
    id: formatActivityId(stored.index), at: stored.at, kind: stored.kind, actor: stored.actor,
    ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}),
    mentions: stored.kind === 'say' ? extractMentions(stored.body) : [],
    ...('target' in stored ? { target: stored.target } : {}),
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}),
  };
}

function parseRequiredActivityId(id: ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

export async function join(square: OperationContext, name: string): Promise<{ readonly name: string; readonly activity: Activity | null }> {
  const now = square.clock();
  const committed = await square.artifact.transact<{ name: string; stored: StoredAct | null }>((state) => {
    const decision = decideJoin(state, name, now);
    if (decision.joinAct === undefined) return { result: { name: decision.joinedName, stored: null } };
    return { state, result: { name: decision.joinedName, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  });
  await ensureLocalPresence(square, committed.name);
  return { name: committed.name, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

/** Automatic presence distinguishes first entry, current presence, and completed presence. */
export async function implicitJoin(square: OperationContext, name: string): Promise<{ readonly name: string; readonly state: 'joined' | 'active' | 'done'; readonly activity: Activity | null }> {
  const now = square.clock();
  const committed = await square.artifact.transact<{ name: string; state: 'joined' | 'active' | 'done'; stored: StoredAct | null }>((state) => {
    const decision = decideImplicitJoin(state, name, now);
    if (decision.joinAct === undefined) return { result: { name: decision.joinedName, state: decision.state, stored: null } };
    return { state, result: { name: decision.joinedName, state: decision.state, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  });
  await ensureLocalPresence(square, committed.name);
  return { name: committed.name, state: committed.state, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

export async function express(square: OperationContext, name: string, body: string, options: ExpressOptions = {}): Promise<ExpressResult> {
  const now = square.clock();
  const reply = options.reply === undefined ? undefined : parseRequiredActivityId(options.reply);
  const committed = await square.artifact.transact((state) => {
    const decision = decideAct(state, { name, body, force: options.force ?? false, now, ...(options.reach === undefined ? {} : { reach: options.reach }), ...(reply === undefined ? {} : { reply }) });
    if (decision.type === 'blocked') {
      const pending = decision.activitySummaries.reduce((count, summary) => count + summary.count, 0) + decision.unreadRoomChanges.length;
      throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { pending });
    }
    if (decision.type === 'held') {
      const holder = state.acts.filter((activity) => activity.kind === 'hold').at(-1)?.actor;
      throw new SquareError('held', 'The square is held', holder === undefined ? undefined : { holder });
    }
    if (decision.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`);
    if (decision.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: decision.delayMs });
    if (decision.type === 'bell_quota') throw new SquareError('bell_quota', `${participantIdentity(name)} cannot ring the bell yet`, { retryAfterMs: Math.max(1, decision.nextAt - now) });
    const stored = committedActivity(storeActs(state, [decision.act]), 'express');
    return { state, result: { stored } };
  });
  await ensureLocalPresence(square, name);
  const activity = exposeActivity(committed.stored);
  return { activity };
}

export interface ListenerChangeResult {
  readonly activity: Activity | null;
}

async function landListenerChange(
  square: OperationContext,
  verb: 'listen' | 'ignore',
  actor: string,
  target: string,
): Promise<ListenerChangeResult> {
  const now = square.clock();
  const stored = await square.artifact.transact<StoredAct | null>((state) => {
    const act = verb === 'listen'
      ? coreListen(state, actor, target, now)
      : coreIgnore(state, actor, target, now);
    if (act === undefined) return { result: null };
    return { state, result: committedActivity(storeActs(state, [act]), verb) };
  });
  return { activity: stored === null ? null : exposeActivity(stored) };
}

export function listen(square: OperationContext, actor: string, target: string): Promise<ListenerChangeResult> {
  return landListenerChange(square, 'listen', actor, target);
}

export function ignore(square: OperationContext, actor: string, target: string): Promise<ListenerChangeResult> {
  return landListenerChange(square, 'ignore', actor, target);
}

export async function listening(square: OperationContext, actor: string): Promise<readonly string[]> {
  const { state } = await square.artifact.read();
  return coreListening(state, actor);
}

async function landCore(square: OperationContext, verb: 'done' | 'hold' | 'resume', actor: string, body = ''): Promise<ExpressResult> {
  const now = square.clock();
  const stored = await square.artifact.transact((state) => {
    const act = verb === 'done' ? coreDone(state, actor, body, now) : verb === 'hold' ? coreHold(state, actor, body, now) : coreResume(state, actor, now);
    return { state, result: committedActivity(storeActs(state, [act]), verb) };
  });
  return { activity: exposeActivity(stored) };
}

export function done(square: OperationContext, name: string, body = ''): Promise<ExpressResult> { return landCore(square, 'done', name, body); }
export function hold(square: OperationContext, name: string, reason = ''): Promise<ExpressResult> { return landCore(square, 'hold', name, reason); }
export function resume(square: OperationContext, name: string): Promise<ExpressResult> { return landCore(square, 'resume', name); }
