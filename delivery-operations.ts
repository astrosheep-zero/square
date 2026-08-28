import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { nameKey, type SquareState } from './model.js';
import type { HostLedgerPort, PresenceRecord, SquareArtifactPort, DeliverPendingInput, DeliveryResult, ObserveSquareInput, ReconcileBindingInput, SquareObservation } from './ports.js';
import { deriveDeliveryModel } from './delivery.js';
import { isWakeRouteAttemptable, type WakeAttempt } from './square-projections.js';

export async function observeSquare(input: ObserveSquareInput): Promise<SquareObservation> {
  const snapshot = await input.artifact.read();
  const delivery = deriveDeliveryModel(snapshot.state);
  const rows = input.hostLedger === undefined ? [] : await input.hostLedger.listPresence({ location: input.location, scopes: ['user', 'local'], now: input.now });
  const bindings = rows.map((record) => ({
    location: record.location,
    participant: record.participant,
    sessionId: record.session,
    channel: record.channel,
    ...(record.route === undefined ? {} : { route: { location: record.location, participant: record.participant, sessionId: record.session, channel: record.channel, kind: record.route.kind, address: { ...record.route.address }, updatedAt: record.updatedAt ?? 0 } }),
    updatedAt: record.updatedAt ?? 0,
  }));
  return { ...(input.location === undefined ? {} : { location: input.location }), version: snapshot.version, state: snapshot.state, pending: delivery.joinedRecipients().map((recipient) => ({ recipient, notifications: delivery.pendingFor(recipient) })), bindings };
}

export async function reconcileBinding(input: ReconcileBindingInput) {
  return input.hostLedger.reconcileBinding({ artifact: input.artifact, scopes: input.scopes, now: input.now });
}

export async function deliverPending(input: DeliverPendingInput): Promise<DeliveryResult> {
  const observation = await observeSquare({ artifact: input.artifact, hostLedger: input.hostLedger, location: input.location, now: input.now });
  const routes = (await input.hostLedger.listPresence({ location: input.location, scopes: ['user'], now: input.now })).filter((binding) => binding.route !== undefined);
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
        const leaseMs = input.timeoutMs ?? 5000;
        let leaseId = randomUUID();
        let lease = await input.hostLedger.claimWakeDispatch({ attention, leaseId, leaseMs, session: route.session, at: input.now });
        if (lease.type === 'ambiguous') {
          await input.hostLedger.appendEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', outcome: 'unknown', routeKind: lease.lease.routeKind ?? route.route!.kind, attemptN: lease.lease.attemptN ?? 1, signature: 'worker_interrupted_during_dispatch', message: 'The notification worker ended after dispatch began; transport acceptance is unknown.', at: input.now });
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId: lease.lease.leaseId, session: route.session, at: input.now });
          leaseId = randomUUID();
          lease = await input.hostLedger.claimWakeDispatch({ attention, leaseId, leaseMs, session: route.session, at: input.now });
        }
        if (lease.type !== 'acquired') continue;
        const attempts = await input.hostLedger.listWakeAttempts({ attention, session: route.session, now: input.now });
        const attemptN = attempts.reduce((highest, record) => Math.max(highest, record.attemptN ?? 0), 0) + 1;
        const request = { location: input.location, participant: membership.recipient, activity, route: { location: route.location, participant: route.participant, sessionId: route.session, channel: route.channel, kind: route.route!.kind, address: { ...route.route!.address }, updatedAt: route.updatedAt ?? 0 } };
        let outcome;
        const claim = await input.hostLedger.claimEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', leaseMs, now: input.now });
        if (claim.status !== 'acquired') { await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now }); continue; }
        attempted += 1;
        const dispatching = await input.hostLedger.transitionWakeDispatch({ attention, leaseId, phase: 'dispatching', leaseMs, routeKind: route.route!.kind, attemptN, session: route.session, at: input.now });
        if (!dispatching) { await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now }); continue; }
        try { outcome = await Promise.race([input.transport.attempt(request, leaseMs), new Promise<import('./ports.js').WakeOutcome>((resolve) => setTimeout(() => resolve({ outcome: 'unknown', diagnostic: 'transport timeout' }), leaseMs))]); }
        catch (error) { outcome = { outcome: 'unknown' as const, diagnostic: error instanceof Error ? error.message : String(error) }; }
        if (outcome.outcome === 'failed' && outcome.unavailable) { await input.transport.invalidate?.(request); await input.hostLedger.releaseEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', now: input.now }); await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now }); failed += 1; continue; }
        await input.hostLedger.appendEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', outcome: outcome.outcome, routeKind: route.route!.kind, attemptN: outcome.attemptN ?? attemptN, ...(outcome.outcome === 'accepted' && outcome.signature === undefined ? {} : outcome.outcome === 'accepted' ? { signature: outcome.signature } : outcome.outcome === 'failed' ? { message: outcome.message } : { diagnostic: outcome.diagnostic }), at: input.now });
        await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session, at: input.now });
        if (outcome.outcome === 'accepted') accepted += 1; else if (outcome.outcome === 'failed') failed += 1; else unknown += 1;
      }
    }
  }
  return { attempted, accepted, failed, unknown };
}

export function selectPendingWakeActivities(state: SquareState, routes: readonly PresenceRecord[], attempts: readonly WakeAttempt[], now: number, graceMs: number, limit: number, delivery = deriveDeliveryModel(state)): number[] {
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

export async function sweepPending(input: { readonly artifact: SquareArtifactPort; readonly hostLedger: HostLedgerPort; readonly location: string; readonly now: number; readonly graceMs: number; readonly limit: number }): Promise<number[]> {
  const { state } = await input.artifact.read();
  return sweepPendingFromState({ ...input, state });
}

export async function sweepPendingFromState(input: { readonly state: SquareState; readonly hostLedger: HostLedgerPort; readonly location: string; readonly now: number; readonly graceMs: number; readonly limit: number; readonly deriveDelivery?: (snapshot: SquareState) => ReturnType<typeof deriveDeliveryModel> }): Promise<number[]> {
  const [bindings, records] = await Promise.all([input.hostLedger.listPresence({ location: input.location, scopes: ['user'], now: input.now }), input.hostLedger.listWakeAttempts({ now: input.now })]);
  const attempts: WakeAttempt[] = records.flatMap((record) => {
    const index = parseActivityId(record.activity);
    if (index === undefined || record.routeKind === undefined || typeof record.attemptN !== 'number') return [];
    return [{ at: record.at ?? input.now, attention: { squarePath: record.location, actIndex: index, recipient: record.participant }, routeKind: record.routeKind, outcome: record.outcome as WakeAttempt['outcome'], attemptN: record.attemptN, ...(record.session === undefined ? {} : { session: record.session }) }];
  });
  const delivery = input.deriveDelivery?.(input.state) ?? deriveDeliveryModel(input.state);
  return selectPendingWakeActivities(input.state, bindings, attempts, input.now, input.graceMs, input.limit, delivery);
}
