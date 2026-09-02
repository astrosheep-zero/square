import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { nameKey, type SquareState } from './model.js';
import type { HostLedgerPort, PresenceRecord, SquareArtifactPort, DeliverPendingInput, DeliveryResult, ObserveSquareInput, ReconcileBindingInput, SquareObservation, WakeRequest, WakeTransportPort } from './ports.js';
import { deriveDeliveryModel } from './delivery.js';
import { isWakeRouteAttemptable, type WakeAttempt } from './square-projections.js';
import { retireWakeRouteFromArtifact } from './routes.js';
async function attemptWakeWithin(
  transport: WakeTransportPort,
  request: WakeRequest,
  timeoutMs: number,
): Promise<import('./ports.js').WakeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<import('./ports.js').WakeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'unknown', diagnostic: 'transport timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([transport.attempt(request, timeoutMs), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export async function observeSquare(input: ObserveSquareInput): Promise<SquareObservation> {
  const snapshot = await input.artifact.read();
  const delivery = deriveDeliveryModel(snapshot.state);
  let rows: readonly PresenceRecord[] = [];
  if (input.hostLedger !== undefined) {
    try { rows = await input.hostLedger.listPresence({ location: input.location, scopes: ['user', 'local'], now: input.now }); } catch { rows = []; }
  }
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
  const routes = (observation.state.routes ?? []).map((route) => ({
    location: route.location,
    participant: route.participant,
    session: route.sessionId,
    channel: route.channel as import('./host-ledger.js').PresenceChannel,
    route: { kind: route.kind, address: route.address },
    updatedAt: route.updatedAt,
  }));
  const liveRoutes = routes.filter((route) => observation.bindings.some((binding) =>
    nameKey(binding.participant) === nameKey(route.participant)
    && binding.sessionId === route.session
    && binding.location === route.location
    && (binding.route !== undefined && binding.route.kind === route.route!.kind
      && JSON.stringify(binding.route.address) === JSON.stringify(route.route!.address))
  ));
  let attempted = 0; let accepted = 0; let failed = 0; let unknown = 0; let notCapable = 0;
  for (const membership of observation.pending) {
    for (const notification of membership.notifications) {
      if (input.activity !== undefined) {
        const requested = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
        if (requested === undefined || requested !== notification.item.index) continue;
      }
      const candidates = liveRoutes.filter((route) => nameKey(route.participant) === nameKey(membership.recipient));
      let acceptedForAttention = false;
      let failedForAttention = false;
      let unknownForAttention = false;
      let notCapableForAttention = false;
      try {
        const prior = await input.hostLedger.listWakeAttempts({ attention: { squarePath: input.location, actIndex: notification.item.index, recipient: membership.recipient }, now: Date.now() });
        acceptedForAttention = prior.some((attempt) => attempt.outcome === 'accepted');
      } catch { /* capability is handled by the route-level probe */ }
      if (acceptedForAttention) continue;
      if (candidates.length === 0) notCapableForAttention = true;
      for (const route of candidates) {
        const activity = formatActivityId(notification.item.index);
        const attention = { squarePath: input.location, actIndex: notification.item.index, recipient: membership.recipient };
        const leaseMs = input.timeoutMs ?? 5000;
        const requestRoute = { location: route.location, participant: route.participant, sessionId: route.session, channel: route.channel, kind: route.route!.kind, address: { ...route.route!.address }, updatedAt: route.updatedAt ?? 0 };
        if (input.transport.probe !== undefined) {
          try {
            const probe = await input.transport.probe(requestRoute);
            if (probe === false || (typeof probe === 'object' && probe.outcome === 'not-capable')) { notCapableForAttention = true; continue; }
          } catch { notCapableForAttention = true; continue; }
        }
        let leaseId = randomUUID();
        let lease;
        try { lease = await input.hostLedger.claimWakeDispatch({ attention, leaseId, leaseMs, session: route.session }); }
        catch { notCapableForAttention = true; continue; }
        if (lease.type === 'ambiguous') {
          let recovered = await input.hostLedger.claimEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', leaseMs, claimToken: lease.lease.leaseId });
          if (recovered.status === 'busy' && recovered.record.claimToken !== undefined) {
            await input.hostLedger.releaseEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', claimToken: recovered.record.claimToken });
            recovered = await input.hostLedger.claimEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', leaseMs, claimToken: lease.lease.leaseId });
          }
          if (recovered.status === 'acquired') {
            await input.hostLedger.appendEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', outcome: 'unknown', routeKind: lease.lease.routeKind ?? route.route!.kind, attemptN: lease.lease.attemptN ?? 1, signature: 'worker_interrupted_during_dispatch', message: 'The notification worker ended after dispatch began; transport acceptance is unknown.', claimToken: recovered.claimToken });
          }
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId: lease.lease.leaseId, session: route.session });
          break;
        }
        if (lease.type === 'busy') break;
        if (lease.type !== 'acquired') continue;
        try {
          const completed = await input.hostLedger.listWakeAttempts({ attention, now: Date.now() });
          if (completed.some((attempt) => attempt.outcome === 'accepted')) {
            await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session });
            acceptedForAttention = true;
            break;
          }
        } catch { /* continue with the evidence claim */ }
        let attempts;
        try { attempts = await input.hostLedger.listWakeAttempts({ attention, now: Date.now() }); }
        catch { notCapableForAttention = true; await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session }).catch(() => undefined); continue; }
        if (attempts.some((attempt) => attempt.outcome === 'unknown')) {
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session });
          break;
        }
        const sessionAttempts = attempts.filter((attempt) => attempt.session === route.session);
        const attemptN = sessionAttempts.reduce((highest, record) => Math.max(highest, record.attemptN ?? 0), 0) + 1;
        const request = { location: input.location, participant: membership.recipient, activity, actor: notification.item.actor, route: requestRoute };
        let outcome;
        const claim = await input.hostLedger.claimEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', leaseMs, claimToken: leaseId });
        if (claim.status !== 'acquired') { await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session }); if (claim.status === 'degraded') notCapableForAttention = true; continue; }
        const claimToken = claim.claimToken;
        attempted += 1;
        const dispatching = await input.hostLedger.transitionWakeDispatch({ attention, leaseId, phase: 'dispatching', leaseMs, routeKind: route.route!.kind, attemptN, session: route.session });
        if (!dispatching) {
          await input.hostLedger.releaseEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', claimToken }).catch(() => undefined);
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session });
          continue;
        }
        let current: SquareObservation;
        try { current = await observeSquare({ artifact: input.artifact, hostLedger: input.hostLedger, location: input.location, now: input.now }); }
        catch { current = { ...observation, pending: [], bindings: [] }; }
        const stillPending = current.pending.some((entry) => nameKey(entry.recipient) === nameKey(membership.recipient)
          && entry.notifications.some((entryNotification) => entryNotification.item.index === notification.item.index));
        const stillBound = current.bindings.some((binding) => nameKey(binding.participant) === nameKey(route.participant)
          && binding.sessionId === route.session
          && binding.location === route.location
          && (binding.route !== undefined && binding.route.kind === route.route!.kind
            && JSON.stringify(binding.route.address) === JSON.stringify(route.route!.address)));
        const stillPublished = (current.state.routes ?? []).some((published) => published.location === route.location
          && nameKey(published.participant) === nameKey(route.participant)
          && published.sessionId === route.session
          && published.kind === route.route!.kind
          && JSON.stringify(published.address) === JSON.stringify(route.route!.address));
        if (!stillPending || !stillBound || !stillPublished) {
          await input.hostLedger.releaseEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', claimToken }).catch(() => undefined);
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session }).catch(() => undefined);
          continue;
        }
        try { outcome = await attemptWakeWithin(input.transport, request, leaseMs); }
        catch (error) { outcome = { outcome: 'unknown' as const, diagnostic: error instanceof Error ? error.message : String(error) }; }
        if (outcome.outcome === 'not-capable') {
          await input.hostLedger.releaseEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', claimToken }).catch(() => undefined);
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session }).catch(() => undefined);
          notCapableForAttention = true;
          continue;
        }
        if (outcome.outcome === 'failed' && outcome.unavailable) {
          if (outcome.routeStale === true) await retireWakeRouteFromArtifact(input.artifact, { location: route.location, participant: route.participant, sessionId: route.session });
          await input.hostLedger.releaseEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', claimToken });
          await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session });
          failedForAttention = true;
          continue;
        }
        await input.hostLedger.appendEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', outcome: outcome.outcome, routeKind: route.route!.kind, attemptN: outcome.attemptN ?? attemptN, ...(outcome.outcome === 'accepted' && outcome.signature === undefined ? {} : outcome.outcome === 'accepted' ? { signature: outcome.signature } : outcome.outcome === 'failed' ? { message: outcome.message } : { diagnostic: outcome.diagnostic }), claimToken });
        await input.hostLedger.releaseWakeDispatch({ attention, leaseId, session: route.session });
        if (outcome.outcome === 'accepted') { acceptedForAttention = true; break; }
        if (outcome.outcome === 'failed') failedForAttention = true;
        else { unknownForAttention = true; break; }
      }
      if (acceptedForAttention) accepted += 1;
      else if (unknownForAttention) unknown += 1;
      else if (failedForAttention) failed += 1;
      else if (notCapableForAttention) notCapable += 1;
    }
  }
  return { attempted, accepted, failed, unknown, notCapable };
}

export function selectPendingWakeActivities(state: SquareState, routes: readonly PresenceRecord[], attempts: readonly WakeAttempt[], now: number, graceMs: number, limit: number, delivery = deriveDeliveryModel(state)): number[] {
  const selected = new Set<number>();
  for (const membership of delivery.joinedRecipients()) {
    for (const notification of delivery.pendingFor(membership)) {
      if (now - notification.item.at <= graceMs) continue;
      if (attempts.some((attempt) => attempt.attention.actIndex === notification.item.index && nameKey(attempt.attention.recipient) === nameKey(membership) && attempt.outcome === 'accepted')) continue;
      const eligible = routes.some((binding) => {
        if (binding.route === undefined || nameKey(binding.participant) !== nameKey(membership)) return false;
        const matching = attempts.filter((attempt) => attempt.session === binding.session && nameKey(attempt.attention.recipient) === nameKey(membership) && attempt.attention.actIndex === notification.item.index);
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
  const bindings: PresenceRecord[] = (input.state.routes ?? []).map((route) => ({ location: input.location, participant: route.participant, session: route.sessionId, channel: route.channel as import('./host-ledger.js').PresenceChannel, route: { kind: route.kind, address: route.address }, updatedAt: route.updatedAt }));
  let records: readonly import('./host-ledger.js').EvidenceRecord[] = [];
  try { records = await input.hostLedger.listWakeAttempts({ now: input.now }); } catch { records = []; }
  const attempts: WakeAttempt[] = records.flatMap((record) => {
    const index = parseActivityId(record.activity);
    if (index === undefined || record.routeKind === undefined || typeof record.attemptN !== 'number') return [];
    return [{ at: record.at ?? input.now, attention: { squarePath: record.location, actIndex: index, recipient: record.participant }, routeKind: record.routeKind, outcome: record.outcome as WakeAttempt['outcome'], attemptN: record.attemptN, ...(record.session === undefined ? {} : { session: record.session }) }];
  });
  const delivery = input.deriveDelivery?.(input.state) ?? deriveDeliveryModel(input.state);
  return selectPendingWakeActivities(input.state, bindings, attempts, input.now, input.graceMs, input.limit, delivery);
}
