import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { nameKey, type SquareState } from './model.js';
import type { HostLedgerPort, PresenceRecord, PresentationEvidenceProjection, SquareArtifactPort, DeliverPendingInput, DeliveryResult, ObserveSquareInput,  SquareObservation, WakeRequest, WakeTransportPort } from './ports.js';
import { deriveDeliveryModel } from './delivery.js';
import { currentSessionBindings, isWakeRouteAttemptable, presentationSuppressesWake, projectPresentationEvidence } from './square-projections.js';
import { decodeWakeEvidence, type WakeAttempt } from './wake-evidence.js';
import { retireWakeRouteFromArtifact } from './routes.js';
import { redactCurrentDiagnostic } from './diagnostic-redaction.js';

async function releaseWakeClaim(input: {
  readonly hostLedger: HostLedgerPort;
  readonly location: string;
  readonly participant: string;
  readonly session: string;
  readonly activity: string;
  readonly claimToken: string;
  readonly routeKind?: import('./model.js').WakeRouteKind;
  readonly attemptN?: number;
}, details: { readonly signature: string; readonly message: string; readonly diagnostic?: unknown }): Promise<void> {
  await input.hostLedger.releaseEvidence({
    location: input.location,
    participant: input.participant,
    session: input.session,
    activity: input.activity,
    kind: 'wake',
    claimToken: input.claimToken,
    ...(input.routeKind === undefined ? {} : { routeKind: input.routeKind }),
    ...(input.attemptN === undefined ? {} : { attemptN: input.attemptN }),
    signature: details.signature,
    message: redactCurrentDiagnostic(details.message) as string,
    ...(details.diagnostic === undefined ? {} : { diagnostic: redactCurrentDiagnostic(details.diagnostic) }),
  });
}

async function attemptWakeWithin(
  transport: WakeTransportPort,
  request: WakeRequest,
  timeoutMs: number,
  beforeSend?: () => Promise<boolean>,
): Promise<import('./ports.js').WakeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<import('./ports.js').WakeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'unknown', diagnostic: 'transport timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([transport.attempt(request, timeoutMs, beforeSend), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export async function observeSquare(input: ObserveSquareInput): Promise<SquareObservation> {
  const snapshot = await input.artifact.read();
  const delivery = deriveDeliveryModel(snapshot.state);
  let rows: readonly PresenceRecord[] = [];
  if (input.hostLedger !== undefined) {
    try { rows = await input.hostLedger.listPresence({ location: input.location, now: input.now }); } catch { rows = []; }
  }
  const bindings = rows.map((record) => ({
    location: record.location,
    participant: record.participant,
    sessionId: record.session,
    channel: record.channel,
    ...(record.route === undefined ? {} : { route: { location: record.location, participant: record.participant, sessionId: record.session, channel: record.channel, kind: record.route.kind, address: { ...record.route.address }, updatedAt: record.updatedAt ?? 0 } }),
    updatedAt: record.updatedAt ?? 0,
    ...(record.epoch === undefined ? {} : { epoch: record.epoch }),
    ...(record.cancelledThrough === undefined ? {} : { cancelledThrough: record.cancelledThrough }),
  }));
  return { ...(input.location === undefined ? {} : { location: input.location }), version: snapshot.version, state: snapshot.state, pending: delivery.joinedRecipients().map((recipient) => ({ recipient, notifications: delivery.pendingFor(recipient) })), bindings };
}
export async function deliverPending(input: DeliverPendingInput): Promise<DeliveryResult> {
  const observation = await observeSquare({ artifact: input.artifact, hostLedger: input.hostLedger, location: input.location, now: input.now });
  const routes = (observation.state.routes ?? []).flatMap((route) => {
    const owner = observation.bindings.find((binding) => nameKey(binding.participant) === nameKey(route.participant)
      && binding.sessionId === route.sessionId && binding.location === route.location
      && (route.epoch === undefined || binding.epoch === route.epoch));
    if (owner === undefined) return [];
    return [{
      location: route.location,
      participant: route.participant,
      session: route.sessionId,
      channel: route.channel as import('./host-ledger.js').PresenceChannel,
      route: { kind: route.kind, address: route.address },
      updatedAt: route.updatedAt,
      epoch: route.epoch,
      cancelledThrough: owner.cancelledThrough,
    }];
  });
  const liveRoutes = currentSessionBindings(routes);
  let presentations: readonly PresentationEvidenceProjection[] = [];
  try { presentations = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: input.location, now: input.now }); } catch { /* capability is handled by the route-level wake checks */ }
  let attempted = 0; let accepted = 0; let failed = 0; let unknown = 0; let notCapable = 0;
  for (const membership of observation.pending) {
    for (const notification of membership.notifications) {
      if (input.activity !== undefined) {
        const requested = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
        if (requested === undefined || requested !== notification.item.index) continue;
      }
      const candidates = liveRoutes.filter((route) => nameKey(route.participant) === nameKey(membership.recipient)
        && notification.item.index > (route.cancelledThrough ?? -1));
      let acceptedForAttention = false;
      let failedForAttention = false;
      let unknownForAttention = false;
      let notCapableForAttention = false;
      // Already-accepted attention is a no-op even if its route is no longer available.
      try {
        const prior = await input.hostLedger.listWakeAttempts({ attention: { squarePath: input.location, actIndex: notification.item.index, recipient: membership.recipient }, now: Date.now() });
        if (prior.some((attempt) => attempt.outcome === 'accepted')) continue;
      } catch { /* the atomic claim below still gates dispatch */ }
      if (candidates.length === 0) notCapableForAttention = true;
      for (const route of candidates) {
        const activity = formatActivityId(notification.item.index);
        const presented = presentations.filter((row) => row.activity === activity && row.participant.toLocaleLowerCase() === membership.recipient.toLocaleLowerCase() && row.sessionId === route.session && presentationSuppressesWake([row]));
        if (presented.length > 0) continue;
        const attention = { squarePath: input.location, actIndex: notification.item.index, recipient: membership.recipient };
        const leaseMs = input.timeoutMs ?? 5000;
        const requestRoute = { location: route.location, participant: route.participant, sessionId: route.session, channel: route.channel, kind: route.route!.kind, address: { ...route.route!.address }, updatedAt: route.updatedAt ?? 0, epoch: route.epoch };
        if (input.transport.probe !== undefined) {
          try {
            const probe = await input.transport.probe(requestRoute);
            if (probe === false || (typeof probe === 'object' && probe.outcome === 'not-capable')) { notCapableForAttention = true; continue; }
          } catch { notCapableForAttention = true; continue; }
        }
        let claim: import('./host-ledger.js').WakeAttemptClaim;
        try { claim = await input.hostLedger.claimWakeAttempt({ attention, session: route.session, routeKind: route.route!.kind, leaseMs }); }
        catch { notCapableForAttention = true; continue; }
        if (claim.status === 'degraded') { notCapableForAttention = true; continue; }
        // Busy and terminal outcomes are attention-wide: no other session or route may dispatch.
        // A terminal attempt was already accepted or may already have been sent, so it reports nothing new.
        if (claim.status === 'busy') break;
        if (claim.status === 'terminal') break;
        const { claimToken, attemptN } = claim;
        const request = { location: input.location, participant: membership.recipient, activity, actor: notification.item.actor, route: requestRoute };
        const claimRelease: Parameters<typeof releaseWakeClaim>[0] = { hostLedger: input.hostLedger, location: input.location, participant: membership.recipient, session: route.session, activity, claimToken, routeKind: route.route!.kind, attemptN };
        // One teardown path for every exit after claim acquisition; each call site keeps its own error policy.
        const abandon = async (details: Parameters<typeof releaseWakeClaim>[1], options: { readonly bestEffortClaim?: boolean } = {}): Promise<void> => {
          const release = releaseWakeClaim(claimRelease, details);
          if (options.bestEffortClaim === true) await release.catch(() => undefined);
          else await release;
        };
        let current: SquareObservation;
        try { current = await observeSquare({ artifact: input.artifact, hostLedger: input.hostLedger, location: input.location, now: input.now }); }
        catch { current = { ...observation, pending: [], bindings: [] }; }
        const stillPending = current.pending.some((entry) => nameKey(entry.recipient) === nameKey(membership.recipient)
          && entry.notifications.some((entryNotification) => entryNotification.item.index === notification.item.index));
        const stillBound = current.bindings.some((binding) => nameKey(binding.participant) === nameKey(route.participant)
          && binding.sessionId === route.session
          && binding.location === route.location);
        const stillPublished = (current.state.routes ?? []).some((published) => published.location === route.location
          && nameKey(published.participant) === nameKey(route.participant)
          && published.sessionId === route.session
          && published.kind === route.route!.kind
          && JSON.stringify(published.address) === JSON.stringify(route.route!.address));
        if (!stillPending || !stillBound || !stillPublished) {
          await abandon({
            signature: 'pre_send_revalidation_failed',
            message: 'Wake was not sent because the activity, session binding, or published route changed before dispatch.',
            diagnostic: { pending: stillPending, bound: stillBound, publishedRoute: stillPublished },
          }, { bestEffortClaim: true }).catch(() => undefined);
          continue;
        }
        let latestPresentations: readonly PresentationEvidenceProjection[] = [];
        try { latestPresentations = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: input.location, participant: membership.recipient, sessionId: route.session, activity, now: input.now }); } catch { /* capability is handled by the transport path */ }
        if (presentationSuppressesWake(latestPresentations)) {
          await abandon({
            signature: 'presentation_already_recorded',
            message: 'Wake was suppressed because presentation evidence already exists.',
            diagnostic: { outcomes: latestPresentations.map((row) => row.outcome) },
          }, { bestEffortClaim: true }).catch(() => undefined);
          continue;
        }
        let outcome;
        let suppressedDuringSend = false;
        const beforeSend = async () => {
          let finalPresentations: readonly PresentationEvidenceProjection[] = [];
          try { finalPresentations = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: input.location, participant: membership.recipient, sessionId: route.session, activity, now: Date.now() }); } catch { /* capability is handled by the transport path */ }
          suppressedDuringSend = presentationSuppressesWake(finalPresentations);
          return !suppressedDuringSend;
        };
        try { outcome = await attemptWakeWithin(input.transport, { ...request, claimToken, attemptN }, leaseMs, beforeSend); }
        catch (error) { outcome = { outcome: 'unknown' as const, diagnostic: error instanceof Error ? error.message : String(error) }; }
        if (suppressedDuringSend) {
          await abandon({
            signature: 'presentation_recorded_during_dispatch',
            message: 'Wake was cancelled because presentation evidence appeared before the final send check.',
          }, { bestEffortClaim: true }).catch(() => undefined);
          continue;
        }
        attempted += 1;
        if (outcome.outcome === 'not-capable') {
          await abandon({
            signature: 'transport_not_capable',
            message: 'The wake transport reported that it could not deliver this route.',
            diagnostic: outcome.diagnostic,
          }, { bestEffortClaim: true }).catch(() => undefined);
          notCapableForAttention = true;
          continue;
        }
        if (outcome.outcome === 'failed' && outcome.unavailable) {
          if (outcome.routeStale === true) await retireWakeRouteFromArtifact(input.artifact, { location: route.location, participant: route.participant, sessionId: route.session });
          await abandon({
            signature: outcome.signature ?? 'transport_unavailable',
            message: outcome.message ?? 'The wake transport was unavailable.',
            diagnostic: outcome.diagnostic,
          });
          failedForAttention = true;
          continue;
        }
        const safeOutcome = redactCurrentDiagnostic(outcome) as typeof outcome;
        await input.hostLedger.appendEvidence({ location: input.location, participant: membership.recipient, session: route.session, activity, kind: 'wake', outcome: safeOutcome.outcome, routeKind: route.route!.kind, attemptN, ...(safeOutcome.signature === undefined ? {} : { signature: safeOutcome.signature }), ...(safeOutcome.outcome !== 'accepted' && safeOutcome.message !== undefined ? { message: safeOutcome.message } : {}), ...(safeOutcome.outcome !== 'accepted' && safeOutcome.diagnostic !== undefined ? { diagnostic: safeOutcome.diagnostic } : {}), claimToken });
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

export function selectPendingWakeActivities(state: SquareState, routes: readonly PresenceRecord[], attempts: readonly WakeAttempt[], now: number, graceMs: number, limit: number, delivery = deriveDeliveryModel(state), presentations: readonly PresentationEvidenceProjection[] = []): number[] {
  const selected = new Set<number>();
  for (const membership of delivery.joinedRecipients()) {
    for (const notification of delivery.pendingFor(membership)) {
      if (now - notification.item.at <= graceMs) continue;
      if (attempts.some((attempt) => attempt.attention.actIndex === notification.item.index && nameKey(attempt.attention.recipient) === nameKey(membership) && attempt.outcome === 'accepted')) continue;
      const eligible = routes.some((binding) => {
        if (binding.route === undefined || nameKey(binding.participant) !== nameKey(membership)) return false;
        if (notification.item.index <= (binding.cancelledThrough ?? -1)) return false;
        const presented = presentations.filter((row) => row.activity === formatActivityId(notification.item.index) && row.participant.toLocaleLowerCase() === membership.toLocaleLowerCase() && row.sessionId === binding.session && presentationSuppressesWake([row]));
        if (presented.length > 0) return false;
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
  const owners = input.state.routes?.some((route) => route.epoch !== undefined)
    ? await input.hostLedger.listPresence({ location: input.location, now: input.now }) : [];
  const bindings: PresenceRecord[] = currentSessionBindings((input.state.routes ?? []).flatMap((route) => {
    const owner = owners.find((row) => row.session === route.sessionId && nameKey(row.participant) === nameKey(route.participant));
    if (route.epoch !== undefined && (!owner || owner.epoch !== route.epoch)) return [];
    return [{ location: input.location, participant: route.participant, session: route.sessionId, channel: route.channel as import('./host-ledger.js').PresenceChannel, route: { kind: route.kind, address: route.address }, updatedAt: route.updatedAt, ...(owner?.cancelledThrough === undefined ? {} : { cancelledThrough: owner.cancelledThrough }) }];
  }));
  let records: readonly import('./host-ledger.js').EvidenceRecord[] = [];
  try { records = await input.hostLedger.listWakeAttempts({ now: input.now }); } catch { records = []; }
  let presentations: readonly PresentationEvidenceProjection[] = [];
  try { presentations = await projectPresentationEvidence({ hostLedger: input.hostLedger, location: input.location, now: input.now }); } catch { presentations = []; }
  const attempts: WakeAttempt[] = records.flatMap((record) => {
    const decoded = decodeWakeEvidence(record, input.now);
    return decoded?.kind === 'attempt' ? [decoded.value] : [];
  });
  const delivery = input.deriveDelivery?.(input.state) ?? deriveDeliveryModel(input.state);
  return selectPendingWakeActivities(input.state, bindings, attempts, input.now, input.graceMs, input.limit, delivery, presentations);
}
