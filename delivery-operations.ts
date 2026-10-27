import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { sameBody, type Seat, type WakeRoute } from './model.js';
import type { DirectedHead, SquareArtifactPort, DeliverPendingInput, DeliveryResult, WakeRequest, WakeTransportPort, SeatRef } from './ports.js';
import { pendingHead, pendingHeads, pendingRecipients, presentationBlocksWake } from './delivery.js';
import { asSeatRef } from './seats.js';
import { canonicalPath } from './canonical-path.js';
import { freshWatchLease } from './runtime.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { leaseOwnsNotification } from './delivery.js';

function routeFor(location: string, seat: Seat, now: number): WakeRoute | undefined {
  if (seat.wakeAddress === undefined) return undefined;
  return {
    location, participant: seat.participant, sessionId: seat.body.session, channel: seat.body.channel,
    kind: seat.wakeAddress.kind, address: { ...seat.wakeAddress.address }, updatedAt: now,
  };
}

interface Currentness {
  readonly current: boolean;
  readonly activityPending: boolean;
  readonly seatCurrent: boolean;
  readonly cancelled: boolean;
  readonly presented: boolean;
}

async function currentness(artifact: SquareArtifactPort, request: WakeRequest, now: number): Promise<Currentness> {
  const index = parseActivityId(request.activity)!;
  const { value } = await artifact.read((facts) => {
    const currentSeat = facts.seat(request.participant);
    const seatCurrent = currentSeat !== undefined && currentSeat.generation === request.seat.generation
      && sameBody(currentSeat.body, request.seat.body)
      && currentSeat.wakeAddress?.kind === request.route.kind
      && Object.keys(currentSeat.wakeAddress.address).length === Object.keys(request.route.address).length
      && Object.entries(currentSeat.wakeAddress.address).every(([key, val]) => request.route.address[key] === val);
    const head = pendingHead(facts, request.participant, index);
    const activityPending = seatCurrent && head !== undefined;
    const cancelledThrough = facts.cancelledThrough(request.participant, request.seat.generation);
    const cancelled = cancelledThrough !== undefined && index <= cancelledThrough;
    const evidence = facts.deliveryEvidence(request.participant, request.seat.generation, formatActivityId(index));
    const presented = presentationBlocksWake(evidence, now);
    const lease = freshWatchLease(facts, request.participant, now);
    const caught = head !== undefined && lease !== undefined && leaseOwnsNotification(lease, {
      actor: request.actor, route: head.route, recipient: request.participant,
    });
    const deferred = deliveryDeferralExpiry(facts, request.seat, index, now) !== undefined;
    return { current: activityPending && !cancelled && !presented && !caught && !deferred, activityPending, seatCurrent, cancelled, presented };
  });
  return value;
}

async function attemptWakeWithin(
  transport: WakeTransportPort,
  request: WakeRequest,
  timeoutMs: number,
  beforeSend: () => Promise<boolean>,
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

interface Candidate {
  readonly seat: Seat;
  readonly head: DirectedHead;
}

async function candidates(artifact: SquareArtifactPort, requested?: number, now = Date.now()): Promise<Candidate[]> {
  const { value } = await artifact.read((facts) => {
    const heads = requested === undefined
      ? facts.roster().flatMap((participant) => participant.joined ? pendingHeads(facts, participant.name) : [])
      : pendingRecipients(facts, requested);
    return heads.flatMap((head) => {
      const seat = facts.seat(head.recipient);
      return seat === undefined || deliveryDeferralExpiry(facts, seat, head.index, now) !== undefined ? [] : [{ seat, head }];
    });
  });
  return value;
}

function releaseClaim(artifact: SquareArtifactPort, seat: SeatRef, activity: ActivityId, claimToken: string,
  signature: string, message?: string, diagnostic?: unknown): Promise<boolean> {
  return artifact.completeDelivery({ seat, activity, claimToken, outcome: 'released', at: Date.now(), signature,
    ...(message === undefined ? {} : { message }),
    ...(diagnostic === undefined ? {} : { diagnostic: safeJson(diagnostic) }),
  }).catch(() => false);
}

function safeJson(value: unknown): import('./model.js').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(safeJson);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, safeJson(item)]));
  return String(value);
}

export async function deliverPending(input: DeliverPendingInput): Promise<DeliveryResult> {
  const location = await canonicalPath(input.location);
  const requested = input.activity === undefined ? undefined
    : typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (input.activity !== undefined && requested === undefined)
    return { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 0 };

  const pending = await candidates(input.artifact, requested, input.now ?? Date.now());
  let attempted = 0, accepted = 0, failed = 0, unknown = 0, notCapable = 0;
  for (const { seat, head } of pending) {
    const route = routeFor(location, seat, input.now ?? Date.now());
    if (route === undefined) { notCapable += 1; continue; }
    const request = {
      location, participant: seat.participant, activity: formatActivityId(head.index), actor: head.actor,
      seat: asSeatRef(seat), route,
      artifact: input.artifact,
    } satisfies WakeRequest;
    if (input.transport.probe !== undefined) {
      try {
        const probe = await input.transport.probe(route);
        if (probe === false || typeof probe === 'object' && probe.outcome === 'not-capable') { notCapable += 1; continue; }
      } catch { notCapable += 1; continue; }
    }

    const claimToken = randomUUID();
    const leaseMs = input.timeoutMs ?? 5000;
    const claim = await input.artifact.claimDelivery({ seat: request.seat, activity: request.activity, kind: 'wake',
      route: seat.wakeAddress, at: input.now ?? Date.now(), leaseMs, claimToken }).catch(() => ({ status: 'stale' as const }));
    if (claim.status !== 'acquired') continue;
    const withClaim = { ...request, claimToken, attemptN: claim.attemptN };
    let final: Currentness | undefined;
    let suppressed = false;
    const beforeSend = async () => {
      try {
        final = await currentness(input.artifact, withClaim, input.now ?? Date.now());
        suppressed = !final.current;
      } catch { suppressed = true; }
      return !suppressed;
    };

    let before: Currentness | undefined;
    try { before = await currentness(input.artifact, withClaim, input.now ?? Date.now()); } catch { /* unverifiable */ }
    if (!before?.current) {
      await releaseClaim(input.artifact, request.seat, request.activity, claimToken, 'pre_send_revalidation_failed',
        before === undefined ? 'Square delivery state could not be verified.' : 'The notification is no longer current.', before);
      continue;
    }

    let outcome: import('./ports.js').WakeOutcome;
    try { outcome = await attemptWakeWithin(input.transport, withClaim, leaseMs, beforeSend); }
    catch (error) { outcome = { outcome: 'unknown', diagnostic: error instanceof Error ? error.message : String(error) }; }
    if (suppressed) {
      await releaseClaim(input.artifact, request.seat, request.activity, claimToken, 'pre_send_revalidation_failed',
        'The notification changed before the final send check.', final ?? { observationAvailable: false });
      continue;
    }

    if (outcome.outcome === 'not-capable') {
      await releaseClaim(input.artifact, request.seat, request.activity, claimToken, 'transport_not_capable', undefined, outcome.diagnostic);
      notCapable += 1;
      continue;
    }

    attempted += 1;
    const mapped = outcome.outcome === 'accepted' ? 'accepted'
      : outcome.outcome === 'unknown' ? 'unknown' : 'failed';
    const completed = await input.artifact.completeDelivery({ seat: request.seat, activity: request.activity, claimToken,
      outcome: mapped, at: Date.now(),
      ...('signature' in outcome && outcome.signature !== undefined ? { signature: outcome.signature } : {}),
      ...('message' in outcome && outcome.message !== undefined ? { message: outcome.message } : {}),
      ...('diagnostic' in outcome && outcome.diagnostic !== undefined ? { diagnostic: safeJson(outcome.diagnostic) } : {}),
    }).catch(() => false);
    if (!completed) continue;
    if (mapped === 'accepted') accepted += 1;
    else if (mapped === 'unknown') unknown += 1;
    else failed += 1;
  }
  return { attempted, accepted, failed, unknown, notCapable };
}

export async function sweepPending(input: {
  readonly artifact: SquareArtifactPort;
  readonly location: string;
  readonly now: number;
  readonly graceMs: number;
  readonly limit: number;
}): Promise<number[]> {
  if (input.limit <= 0) return [];
  const pending = await candidates(input.artifact, undefined, input.now);
  const selected: number[] = [];
  for (const { head } of pending) {
    if (input.now - head.at <= input.graceMs) continue;
    if (!selected.includes(head.index)) selected.push(head.index);
    if (selected.length >= input.limit) break;
  }
  return selected;
}
