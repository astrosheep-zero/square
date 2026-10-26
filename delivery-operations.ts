import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { sameBody, type Seat, type StoredAct, type WakeRoute } from './model.js';
import type { SquareArtifactPort, DeliverPendingInput, DeliveryResult, WakeRequest, WakeTransportPort, DeliveryEvidence, SeatRef } from './ports.js';
import { pendingNotifications, pendingHead } from './delivery.js';
import { asSeatRef } from './seats.js';
import { canonicalPath } from './canonical-path.js';
import { freshWatchLease } from './runtime.js';
import { leaseOwnsNotification } from './delivery.js';

function routeFor(location: string, seat: Seat, now: number): WakeRoute | undefined {
  if (seat.wakeAddress === undefined) return undefined;
  return {
    location, participant: seat.participant, sessionId: seat.body.session, channel: seat.body.channel,
    kind: seat.wakeAddress.kind, address: { ...seat.wakeAddress.address }, updatedAt: now,
  };
}

function presentationBlocksWake(evidence: readonly DeliveryEvidence[], now: number): boolean {
  return evidence.some((row) => row.kind === 'presentation'
    && (row.outcome === 'presented' || row.outcome === 'clipped' || row.outcome === 'unknown'
      || row.outcome === 'dispatching' && (row.expiresAt === undefined || row.expiresAt > now)));
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
    return { current: activityPending && !cancelled && !presented && !caught, activityPending, seatCurrent, cancelled, presented };
  });
  return value;
}

export async function wakeRequestCurrentness(artifact: SquareArtifactPort, request: WakeRequest, now = Date.now()): Promise<Currentness> {
  return currentness(artifact, request, now);
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
  readonly activity: StoredAct & { readonly kind: 'say' };
}

async function candidates(artifact: SquareArtifactPort, requested?: number): Promise<Candidate[]> {
  const { value } = await artifact.read((facts) => facts.roster().flatMap((participant) => {
    if (!participant.joined) return [];
    const seat = facts.seat(participant.name);
    if (seat === undefined) return [];
    return pendingNotifications(facts, participant.name)
      .filter(({ item }) => requested === undefined || item.index === requested)
      .map(({ item }) => ({ seat, activity: item }));
  }));
  return value;
}

async function finishClaim(input: {
  readonly artifact: SquareArtifactPort;
  readonly seat: SeatRef;
  readonly activity: ActivityId;
  readonly claimToken: string;
  readonly outcome: 'failed' | 'unknown' | 'released';
  readonly now: number;
  readonly signature?: string;
  readonly message?: string;
  readonly diagnostic?: unknown;
}): Promise<void> {
  await input.artifact.completeDelivery({ seat: input.seat, activity: input.activity, claimToken: input.claimToken,
    outcome: input.outcome, at: input.now,
    ...(input.signature === undefined ? {} : { signature: input.signature }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.diagnostic === undefined ? {} : { diagnostic: safeJson(input.diagnostic) }),
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

  const pending = await candidates(input.artifact, requested);
  let attempted = 0, accepted = 0, failed = 0, unknown = 0, notCapable = 0;
  for (const candidate of pending) {
    const { seat, activity } = candidate;
    const route = routeFor(location, seat, input.now ?? Date.now());
    if (route === undefined) { notCapable += 1; continue; }
    const request = {
      location, participant: seat.participant, activity: formatActivityId(activity.index), actor: activity.actor,
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
        final = await currentness(input.artifact, withClaim, Date.now());
        suppressed = !final.current;
      } catch { suppressed = true; }
      return !suppressed;
    };

    let before: Currentness;
    try { before = await currentness(input.artifact, withClaim, input.now ?? Date.now()); }
    catch {
      await finishClaim({ artifact: input.artifact, seat: request.seat, activity: request.activity, claimToken,
        outcome: 'released', now: Date.now(), signature: 'pre_send_revalidation_failed', message: 'Square delivery state could not be verified.' });
      continue;
    }
    if (!before.current) {
      await finishClaim({ artifact: input.artifact, seat: request.seat, activity: request.activity, claimToken,
        outcome: 'released', now: Date.now(), signature: 'pre_send_revalidation_failed', message: 'The notification is no longer current.', diagnostic: before });
      continue;
    }

    let outcome: import('./ports.js').WakeOutcome;
    try { outcome = await attemptWakeWithin(input.transport, withClaim, leaseMs, beforeSend); }
    catch (error) { outcome = { outcome: 'unknown', diagnostic: error instanceof Error ? error.message : String(error) }; }
    if (suppressed) {
      await finishClaim({ artifact: input.artifact, seat: request.seat, activity: request.activity, claimToken,
        outcome: 'released', now: Date.now(), signature: 'pre_send_revalidation_failed',
        message: 'The notification changed before the final send check.', diagnostic: final ?? { observationAvailable: false } });
      continue;
    }

    if (outcome.outcome === 'not-capable') {
      await finishClaim({ artifact: input.artifact, seat: request.seat, activity: request.activity, claimToken,
        outcome: 'released', now: Date.now(), signature: 'transport_not_capable', diagnostic: outcome.diagnostic });
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
  const pending = await candidates(input.artifact);
  const selected: number[] = [];
  for (const { activity } of pending) {
    if (input.now - activity.at <= input.graceMs) continue;
    if (!selected.includes(activity.index)) selected.push(activity.index);
    if (selected.length >= input.limit) break;
  }
  return selected;
}

export { presentationBlocksWake };
