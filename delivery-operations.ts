import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import type { HostLedgerPort, SquareArtifactPort, DeliverPendingInput, DeliveryResult, WakeRequest, WakeTransportPort } from './ports.js';
import { capturePendingScan, collectPending, pendingFacts, pendingHead, pendingPages, sameJoin } from './delivery.js';
import { projectWakeEvidence, wakeIsEligible, type WakeCurrentness } from './wake-eligibility.js';
import { canonicalPath } from './canonical-path.js';
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
export async function deliverPending(input: DeliverPendingInput): Promise<DeliveryResult> {
  const location = await canonicalPath(input.location);
  const requested = input.activity === undefined ? undefined : typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (input.activity !== undefined && requested === undefined) return { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 0 };
  const owners = await input.hostLedger.listPresence({ location, now: input.now ?? Date.now() });
  const { scan, routes, pending } = await collectPending(input.artifact, requested);
  const eligibility = await projectWakeEvidence({ routes, pending, owners, location, hostLedger: input.hostLedger, now: input.now ?? Date.now() });
  const observeCurrentness = async (request: WakeRequest, now: number): Promise<WakeCurrentness & { readonly observationAvailable: boolean }> => {
    const index = parseActivityId(request.activity)!;
    const captured = scan.roster.find((participant) => participant.name === request.participant)!;
    const { value: facts } = await input.artifact.read((facts) => {
      const head = sameJoin(facts, captured) ? pendingHead(facts, request.participant, index) : undefined;
      return { routes: facts.routes(), pending: head === undefined ? [] : [head] };
    });
    const projection = await projectWakeEvidence({ ...facts, bindings: owners, location, hostLedger: input.hostLedger, now });
    return { ...projection.currentness({ ...request, location }), observationAvailable: true };
  };
  let attempted = 0; let accepted = 0; let failed = 0; let unknown = 0; let notCapable = 0;
  for (const participant of scan.roster) {
    const recipient = participant.name;
    for (const notification of pending.filter((head) => head.recipient === recipient)) {
      const evidence = eligibility.evidence(recipient, notification.index);
      if (evidence.terminal !== undefined) continue;
      const candidates = evidence.attemptableRoutes;
      let acceptedForAttention = false;
      let failedForAttention = false;
      let unknownForAttention = false;
      let notCapableForAttention = false;
      if (candidates.length === 0 && !evidence.presented) notCapableForAttention = true;
      for (const route of candidates) {
        const activity = formatActivityId(notification.index);
        const attention = { squarePath: location, actIndex: notification.index, recipient };
        const leaseMs = input.timeoutMs ?? 5000;
        const requestRoute = route;
        if (input.transport.probe !== undefined) {
          try {
            const probe = await input.transport.probe(requestRoute);
            if (probe === false || (typeof probe === 'object' && probe.outcome === 'not-capable')) { notCapableForAttention = true; continue; }
          } catch { notCapableForAttention = true; continue; }
        }
        let claim: import('./host-ledger.js').WakeAttemptClaim;
        try { claim = await input.hostLedger.claimWakeAttempt({ attention, session: route.sessionId, routeKind: route.kind, leaseMs }); }
        catch { notCapableForAttention = true; continue; }
        if (claim.status === 'degraded') { notCapableForAttention = true; continue; }
        // Busy and terminal outcomes are attention-wide: no other session or route may dispatch.
        // A terminal attempt was already accepted or may already have been sent, so it reports nothing new.
        if (claim.status === 'busy') break;
        if (claim.status === 'terminal') break;
        const { claimToken, attemptN } = claim;
        const request = { location: input.location, participant: recipient, activity, actor: notification.actor, route: requestRoute };
        const claimRelease: Parameters<typeof releaseWakeClaim>[0] = { hostLedger: input.hostLedger, location, participant: recipient, session: route.sessionId, activity, claimToken, routeKind: route.kind, attemptN };
        // One teardown path for every exit after claim acquisition; each call site keeps its own error policy.
        const abandon = async (details: Parameters<typeof releaseWakeClaim>[1], options: { readonly bestEffortClaim?: boolean } = {}): Promise<void> => {
          const release = releaseWakeClaim(claimRelease, details);
          if (options.bestEffortClaim === true) await release.catch(() => undefined);
          else await release;
        };
        let current: Awaited<ReturnType<typeof observeCurrentness>>;
        try { current = await observeCurrentness(request, input.now ?? Date.now()); }
        catch {
          await abandon({ signature: 'pre_send_revalidation_failed', message: 'Wake was not sent because current Square delivery state could not be verified.', diagnostic: { observationAvailable: false } }, { bestEffortClaim: true }).catch(() => undefined);
          continue;
        }
        if (!current.current) {
          await abandon({
            signature: current.presented ? 'presentation_already_recorded' : 'pre_send_revalidation_failed',
            message: current.presented ? 'Wake was suppressed because presentation evidence already exists.' : 'Wake was not sent because current attention, session binding, or route no longer matches.',
            diagnostic: current,
          }, { bestEffortClaim: true }).catch(() => undefined);
          continue;
        }
        let outcome;
        let suppressedDuringSend = false;
        let finalCurrentness: Awaited<ReturnType<typeof observeCurrentness>> | undefined;
        const beforeSend = async () => {
          try {
            finalCurrentness = await observeCurrentness(request, Date.now());
            suppressedDuringSend = !finalCurrentness.current;
          } catch { suppressedDuringSend = true; }
          return !suppressedDuringSend;
        };
        try { outcome = await attemptWakeWithin(input.transport, { ...request, claimToken, attemptN }, leaseMs, beforeSend); }
        catch (error) { outcome = { outcome: 'unknown' as const, diagnostic: error instanceof Error ? error.message : String(error) }; }
        if (suppressedDuringSend) {
          await abandon({
            signature: finalCurrentness?.presented === true ? 'presentation_recorded_during_dispatch' : 'pre_send_revalidation_failed',
            message: finalCurrentness === undefined ? 'Wake was not sent because current Square delivery state could not be verified.' : 'Wake was cancelled because current attention, ownership, cancellation, or presentation changed before the final send check.',
            diagnostic: finalCurrentness ?? { observationAvailable: false },
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
          if (outcome.routeStale === true) await retireWakeRouteFromArtifact(input.artifact, { location: route.location, participant: route.participant, sessionId: route.sessionId });
          await abandon({
            signature: outcome.signature ?? 'transport_unavailable',
            message: outcome.message ?? 'The wake transport was unavailable.',
            diagnostic: outcome.diagnostic,
          });
          failedForAttention = true;
          continue;
        }
        const safeOutcome = redactCurrentDiagnostic(outcome) as typeof outcome;
        await input.hostLedger.appendEvidence({ location, participant: recipient, session: route.sessionId, activity, kind: 'wake', outcome: safeOutcome.outcome, routeKind: route.kind, attemptN, ...(safeOutcome.signature === undefined ? {} : { signature: safeOutcome.signature }), ...(safeOutcome.outcome !== 'accepted' && safeOutcome.message !== undefined ? { message: safeOutcome.message } : {}), ...(safeOutcome.outcome !== 'accepted' && safeOutcome.diagnostic !== undefined ? { diagnostic: safeOutcome.diagnostic } : {}), claimToken });
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

export async function sweepPending(input: { readonly artifact: SquareArtifactPort; readonly hostLedger: HostLedgerPort; readonly location: string; readonly now: number; readonly graceMs: number; readonly limit: number }): Promise<number[]> {
  if (input.limit <= 0) return [];
  const location = await canonicalPath(input.location);
  const owners = await input.hostLedger.listPresence({ location, now: input.now });
  const { value: scan } = await input.artifact.read(capturePendingScan);
  const selected: import('./ports.js').DirectedHead[] = [];
  const indexes = new Set<number>();
  for await (const page of pendingPages(input.artifact, scan)) {
    const { value: facts } = await input.artifact.read((facts) => pendingFacts(facts, scan, page));
    const eligibility = await projectWakeEvidence({ ...facts, bindings: owners, location, hostLedger: input.hostLedger, now: input.now });
    for (const head of facts.pending) {
      if (indexes.size >= input.limit && !indexes.has(head.index)) break;
      if (input.now - head.at > input.graceMs && wakeIsEligible(eligibility.evidence(head.recipient, head.index))) {
        selected.push(head); indexes.add(head.index);
      }
    }
    if (indexes.size >= input.limit) break;
  }
  const { value: facts } = await input.artifact.read((facts) => pendingFacts(facts, scan, selected));
  const eligibility = await projectWakeEvidence({ ...facts, bindings: owners, location, hostLedger: input.hostLedger, now: input.now });
  return [...new Set(facts.pending.filter((head) => wakeIsEligible(eligibility.evidence(head.recipient, head.index))).map((head) => head.index))];
}
