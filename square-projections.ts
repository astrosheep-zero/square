import { formatActivityId, parseActivityId } from './square-core.js';
import { nameKey, type InboxNotification, type SquareState } from './model.js';
import type { HostLedgerPort, PresenceRecord, SquareArtifactPort, PresentationEvidenceProjection, PresentationProjection, SessionBindingProjection } from './ports.js';
import { deriveDeliveryModel } from './delivery.js';
import { freshWatchLease } from './runtime.js';
import type { WakeRoute, WakeRouteKind } from './model.js';
import { canonicalRouteLocation } from './routes.js';

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

export async function projectSessionBindings(input: {
  readonly hostLedger: HostLedgerPort;
  readonly sessionId: string;
  readonly location?: string;
  readonly scopes?: readonly import('./host-ledger.js').HostLedgerScope[];
  readonly now?: number;
}): Promise<readonly SessionBindingProjection[]> {
  const rows = await input.hostLedger.listPresence({ location: input.location, session: input.sessionId, scopes: input.scopes ?? ['user', 'local'], now: input.now });
  return rows.map(bindingProjection);
}

export function sessionIdsFromEnvironment(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID, env.OPENCODE_SESSION_ID, env.SQUARE_PI_SESSION_ID, env.PASEO_AGENT_ID]
    .map((value) => value?.trim()).filter((value): value is string => Boolean(value));
}

export async function projectLocalParticipantBinding(input: {
  readonly hostLedger: HostLedgerPort;
  readonly location: string;
  readonly participant: string;
  readonly sessionIds: readonly string[];
  readonly now?: number;
}): Promise<SessionBindingProjection | undefined> {
  const bindings = (await Promise.all(input.sessionIds.map((sessionId) => projectSessionBindings({ hostLedger: input.hostLedger, location: input.location, sessionId, scopes: ['user', 'local'], now: input.now })))).flat();
  return bindings.find((binding) => binding.participant.toLocaleLowerCase() === input.participant.toLocaleLowerCase());
}

export async function projectPresentation(input: {
  readonly artifact: SquareArtifactPort;
  readonly binding: SessionBindingProjection;
  readonly now?: number;
}): Promise<PresentationProjection> {
  const { state } = await input.artifact.read();
  const delivery = deriveDeliveryModel(state);
  const known = delivery.knownParticipant(input.binding.participant);
  if (known === undefined || !delivery.joinedRecipients().some((recipient) => recipient.toLocaleLowerCase() === known.toLocaleLowerCase())) return { binding: input.binding, joined: false, notifications: [] };
  const binding = input.binding.participant === known ? input.binding : { ...input.binding, participant: known };
  const notifications: InboxNotification[] = delivery.pendingFor(known).map(({ item, route }) => ({ actIndex: item.index, actor: item.actor, at: item.at, route, body: item.body }));
  const lease = freshWatchLease(state, known, input.now ?? Date.now());
  return { binding, joined: true, notifications, ...(lease === undefined ? {} : { catchLease: lease }) };
}

export async function projectPresentationEvidence(input: {
  readonly hostLedger: HostLedgerPort;
  readonly location?: string;
  readonly participant?: string;
  readonly sessionId?: string;
  readonly activity?: string;
  readonly now?: number;
}): Promise<readonly PresentationEvidenceProjection[]> {
  const rows = await input.hostLedger.listEvidence({ kind: 'presentation', location: input.location, participant: input.participant, session: input.sessionId, activity: input.activity, now: input.now });
  return rows.map((row) => ({ location: row.location, participant: row.participant, sessionId: row.session, activity: row.activity, outcome: row.outcome, ...(row.at === undefined ? {} : { at: row.at }) }));
}

export interface WakeAttempt {
  readonly at: number;
  readonly attention: { readonly squarePath: string; readonly actIndex: number; readonly recipient: string };
  readonly routeKind: WakeRouteKind;
  readonly outcome: 'accepted' | 'unknown' | 'failed';
  readonly signature?: string;
  readonly attemptN: number;
  readonly session?: string;
  readonly message?: string;
  readonly diagnostic?: unknown;
}

export function terminalWakeEvidence(attempts: readonly WakeAttempt[]): WakeAttempt | undefined { return attempts.findLast((attempt) => attempt.outcome === 'accepted'); }
export function isWakeRouteAttemptable(route: Pick<WakeRoute, 'kind' | 'updatedAt'>, attempts: readonly WakeAttempt[]): boolean {
  if (terminalWakeEvidence(attempts) !== undefined) return false;
  if (attempts.some((attempt) => attempt.routeKind === route.kind && attempt.outcome === 'unknown')) return false;
  return true;
}
export function hasAttemptableWakeRoute(routes: readonly Pick<WakeRoute, 'kind' | 'updatedAt'>[], attempts: readonly WakeAttempt[]): boolean { return routes.some((route) => isWakeRouteAttemptable(route, attempts)); }

export interface WakeEvidence {
  readonly delivered: boolean;
  readonly presented: boolean;
  readonly attempts: readonly WakeAttempt[];
  readonly terminal?: WakeAttempt;
  readonly attemptableRoutes: readonly WakeRoute[];
}
export interface WakeEvidenceProjection { evidence(recipient: string, actIndex: number): WakeEvidence }

export async function projectWakeEvidenceFromState(input: {
  readonly location: string;
  readonly state: SquareState;
  readonly hostLedger: HostLedgerPort;
  readonly now: number;
  readonly delivery?: ReturnType<typeof deriveDeliveryModel>;
}): Promise<WakeEvidenceProjection> {
  const canonicalLocation = await canonicalRouteLocation(input.location);
  const delivery = input.delivery ?? deriveDeliveryModel(input.state);
  const bindings: SessionBindingProjection[] = (input.state.routes ?? [])
    .filter((route) => route.location === canonicalLocation || route.location === input.location)
    .map((route) => ({ location: route.location, participant: route.participant, sessionId: route.sessionId, channel: route.channel as import('./host-ledger.js').PresenceChannel, route: { ...route, address: { ...route.address } }, updatedAt: route.updatedAt }));
  const wakeRecords = await input.hostLedger.listEvidence({ location: canonicalLocation, kind: 'wake', now: input.now });
  const attemptsByBinding = new Map<string, WakeAttempt[]>();
  for (const record of wakeRecords) {
    const actIndex = parseActivityId(record.activity);
    if (actIndex === undefined || record.routeKind === undefined || typeof record.attemptN !== 'number') continue;
    const attempt: WakeAttempt = { attention: { squarePath: record.location, recipient: record.participant, actIndex }, outcome: record.outcome as WakeAttempt['outcome'], at: record.at ?? input.now, routeKind: record.routeKind, attemptN: record.attemptN, ...(record.signature === undefined ? {} : { signature: record.signature }), ...(record.session === undefined ? {} : { session: record.session }), ...(record.message === undefined ? {} : { message: record.message }), ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }) };
    const key = JSON.stringify([nameKey(record.participant), actIndex, record.session]);
    const existing = attemptsByBinding.get(key) ?? [];
    existing.push(attempt);
    attemptsByBinding.set(key, existing);
  }
  const presentedRows = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: canonicalLocation, now: input.now });
  return {
    evidence(recipient: string, actIndex: number): WakeEvidence {
      const recipientBindings = bindings.filter((binding) => nameKey(binding.participant) === nameKey(recipient));
      const routes = recipientBindings.flatMap((binding) => binding.route === undefined ? [] : [binding.route]);
      const attempts = recipientBindings.flatMap((binding) => attemptsByBinding.get(JSON.stringify([nameKey(recipient), actIndex, binding.sessionId])) ?? []);
      const terminal = terminalWakeEvidence(attempts);
      const presented = presentedRows.some((row) => row.activity === formatActivityId(actIndex) && row.participant.toLocaleLowerCase() === recipient.toLocaleLowerCase() && recipientBindings.some((binding) => binding.sessionId === row.sessionId));
      return { delivered: delivery.isSeen(recipient, actIndex), presented, attempts, ...(terminal === undefined ? {} : { terminal }), attemptableRoutes: terminal === undefined ? routes.filter((route) => isWakeRouteAttemptable(route, attempts)) : [] };
    },
  };
}

export function wakeIsEligible(evidence: WakeEvidence): boolean { return !evidence.delivered && evidence.terminal === undefined && evidence.attemptableRoutes.length > 0; }
