import { formatActivityId } from './square-core.js';
import { nameKey, type InboxMembership } from './model.js';
import type { HostLedgerPort, PresentationEvidenceProjection, SessionBindingProjection } from './ports.js';
import { leaseOwnsNotification } from './delivery.js';
import { canonicalPath } from './canonical-path.js';

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
  const memberships = pendingAtBoundary([...input.inbox]);
  if (memberships.length === 0) return [];
  const evidence = await projectPresentationEvidence({ hostLedger: input.hostLedger, sessionId: input.sessionId });
  const presented = new Map<string, Set<string>>();
  for (const row of evidence) {
    if (row.outcome !== 'presented' && row.outcome !== 'clipped') continue;
    const key = JSON.stringify([row.location, nameKey(row.participant)]);
    let activities = presented.get(key);
    if (activities === undefined) presented.set(key, activities = new Set());
    activities.add(row.activity);
  }
  const pending: InboxMembership[] = [];
  for (const membership of memberships) {
    const key = JSON.stringify([await canonicalPath(membership.squarePath), nameKey(membership.name)]);
    const activities = presented.get(key);
    const notifications = membership.notifications.filter((notification) => !activities?.has(formatActivityId(notification.actIndex)));
    if (notifications.length > 0) pending.push({ ...membership, notifications });
  }
  return pending;
}

export async function projectSessionBindings(input: {
  readonly hostLedger: HostLedgerPort;
  readonly sessionId?: string;
  readonly location?: string;
  readonly now?: number;
}): Promise<readonly SessionBindingProjection[]> {
  const rows = await input.hostLedger.listPresence({ location: input.location, session: input.sessionId, now: input.now });
  return rows.map((record) => ({
    location: record.location,
    participant: record.participant,
    sessionId: record.session,
    channel: record.channel,
    ...(record.epoch === undefined ? {} : { epoch: record.epoch }),
    ...(record.cancelledThrough === undefined ? {} : { cancelledThrough: record.cancelledThrough }),
    updatedAt: record.updatedAt ?? 0,
  }));
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

