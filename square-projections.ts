import { formatActivityId } from './square-core.js';
import { nameKey, type InboxMembership, type InboxNotification, type SquareState } from './model.js';
import type { HostLedgerPort, PresenceRecord, SquareArtifactPort, PresentationEvidenceProjection, PresentationProjection, SessionBindingProjection } from './ports.js';
import { deriveDeliveryModel, leaseOwnsNotification } from './delivery.js';
import { freshWatchLease } from './runtime.js';
import { attentionBodyIsClipped, renderAttentionPreview } from './attention-presentation.js';
import { canonicalPath } from './canonical-path.js';
import { projectWakeEligibility, type WakeEligibility } from './wake-eligibility.js';

/** A fresh blocking catch owns only the notifications admitted by its filter. */
export function pendingAtBoundary(inbox: InboxMembership[]): InboxMembership[] {
  return inbox.map((membership) => {
    const lease = membership.catchLease;
    if (lease === undefined) return membership;
    return { ...membership, notifications: membership.notifications.filter(
      (notification) => !leaseOwnsNotification(lease, { ...notification, recipient: membership.name }),
    ) };
  }).filter((membership) => membership.notifications.length > 0);
}

/**
 * One eligibility projection for a freshly read session inbox: a fresh catch lease owns what it
 * admitted, and a delivered (or clipped) boundary already raised awareness for its activity, so
 * neither belongs at the next boundary. Ordering, session scoping, suppression outcomes and
 * ledger errors stay exactly as the boundary callers read them.
 */
export async function projectBoundaryEligibility(input: {
  readonly hostLedger: HostLedgerPort;
  readonly sessionId: string;
  readonly inbox: readonly InboxMembership[];
}): Promise<InboxMembership[]> {
  const pending: InboxMembership[] = [];
  for (const membership of pendingAtBoundary([...input.inbox])) {
    const evidence = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: membership.squarePath, participant: membership.name, sessionId: input.sessionId });
    const notifications = membership.notifications.filter((notification) => !presentationSuppressesWake(
      evidence.filter((row) => row.activity === formatActivityId(notification.actIndex)),
    ));
    if (notifications.length > 0) pending.push({ ...membership, notifications });
  }
  return pending;
}

function bindingProjection(record: PresenceRecord): SessionBindingProjection {
  return {
    location: record.location,
    participant: record.participant,
    sessionId: record.session,
    channel: record.channel,
    ...(record.epoch === undefined ? {} : { epoch: record.epoch }),
    ...(record.cancelledThrough === undefined ? {} : { cancelledThrough: record.cancelledThrough }),
    updatedAt: record.updatedAt ?? 0,
  };
}

export async function projectSessionBindings(input: {
  readonly hostLedger: HostLedgerPort;
  readonly sessionId?: string;
  readonly location?: string;
  readonly now?: number;
}): Promise<readonly SessionBindingProjection[]> {
  const rows = await input.hostLedger.listPresence({ location: input.location, session: input.sessionId, now: input.now });
  return rows.map(bindingProjection);
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

export interface NativePendingPreview {
  readonly payload: string;
  readonly clipped: boolean;
}

/** The one native pending preview. `epoch` matches exactly, and each harness pins its own address entry. */
export type NativePendingPreviewInput = {
  readonly location: string; readonly sessionId: string; readonly participant: string;
  readonly actIndex: number; readonly epoch?: number; readonly cancelledThrough?: number; readonly now: number;
} & (
  | { readonly routeKind: 'claude-native'; readonly address: { readonly endpoint: string } }
  | { readonly routeKind: 'opencode-server'; readonly address: { readonly sessionId: string } }
);

export function nativePendingPreview(state: SquareState, input: NativePendingPreviewInput): NativePendingPreview | undefined {
  const route = state.routes?.find((candidate) => candidate.kind === input.routeKind && candidate.sessionId === input.sessionId
    && candidate.epoch === input.epoch && nameKey(candidate.participant) === nameKey(input.participant)
    && (input.routeKind === 'claude-native' ? candidate.address.endpoint === input.address.endpoint : candidate.address.sessionId === input.address.sessionId));
  if (!route || input.actIndex <= (input.cancelledThrough ?? -1)) return undefined;
  const notification = deriveDeliveryModel(state).pendingFor(input.participant).find((entry) => entry.item.index === input.actIndex);
  const lease = freshWatchLease(state, input.participant, input.now);
  if (!notification || (lease !== undefined && leaseOwnsNotification(lease, { ...notification.item, recipient: input.participant, route: notification.route }))) return undefined;
  return { payload: renderAttentionPreview({ squarePath: input.location, recipient: input.participant, actIndex: input.actIndex, actor: notification.item.actor, route: notification.route, body: notification.item.body }), clipped: attentionBodyIsClipped(notification.item.body) };
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

/** Successful boundary output, including a clipped preview, suppresses awareness wake. */
export function presentationSuppressesWake(evidence: readonly Pick<PresentationEvidenceProjection, 'outcome'>[]): boolean {
  return evidence.some((row) => row.outcome === 'clipped' || row.outcome === 'presented');
}

/** Read primary evidence once; wake behavior belongs to the pure eligibility projection. */
export async function projectWakeEvidenceFromState(input: {
  readonly location: string;
  readonly state: SquareState;
  readonly hostLedger: HostLedgerPort;
  readonly now: number;
  readonly delivery?: ReturnType<typeof deriveDeliveryModel>;
}): Promise<WakeEligibility> {
  const canonicalLocation = await canonicalPath(input.location);
  const delivery = input.delivery ?? deriveDeliveryModel(input.state);
  const owners = await input.hostLedger.listPresence({ location: canonicalLocation, now: input.now });
  const wakeRecords = await input.hostLedger.listEvidence({ location: canonicalLocation, kind: 'wake', now: input.now });
  const presentations = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: canonicalLocation, now: input.now });
  return projectWakeEligibility({ state: input.state, location: canonicalLocation, owners, wakeRecords, presentations, now: input.now, delivery });
}
