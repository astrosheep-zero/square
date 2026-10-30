import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { type Seat, type WakeRoute } from './model.js';
import type { DirectedHead, SquareArtifactPort, DeliverPendingInput, WakeRequest } from './ports.js';
import { pendingHead, pendingHeads, pendingRecipients, presentationBlocksWake } from './delivery.js';
import { asSeatRef } from './seats.js';
import { freshWatchLease } from './runtime.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { leaseOwnsNotification } from './delivery.js';
import { dispatchEffect } from './delivery-effects.js';

function routeFor(location: string, seat: Seat, now: number): WakeRoute | undefined {
  if (seat.attachment !== 'attached' || seat.wakeAddress === undefined) return undefined;
  return {
    location, participant: seat.participant,
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
    const seatCurrent = currentSeat !== undefined && currentSeat.attachment === 'attached' && currentSeat.generation === request.seat.generation
      && currentSeat.owner === request.seat.owner
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
      return seat === undefined || seat.attachment !== 'attached' || deliveryDeferralExpiry(facts, seat, head.index, now) !== undefined ? [] : [{ seat, head }];
    });
  });
  return value;
}

function safeJson(value: unknown): import('./model.js').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(safeJson);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, safeJson(item)]));
  return String(value);
}

export async function deliverPending(input: DeliverPendingInput): Promise<void> {
  // The resource owner supplies its identity; delivery does not interpret it as a file.
  const location = input.location;
  const requested = input.activity === undefined ? undefined
    : typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (input.activity !== undefined && requested === undefined) return;

  const pending = await candidates(input.artifact, requested, input.now ?? Date.now());
  // Preserve order within a receiving owner; unrelated receivers need not wait for each other.
  const receivers = new Map<string, Candidate[]>();
  for (const candidate of pending) {
    const key = candidate.seat.owner;
    const group = receivers.get(key) ?? [];
    group.push(candidate);
    receivers.set(key, group);
  }
  const dispatch = async ({ seat, head }: Candidate): Promise<void> => {
    const route = routeFor(location, seat, input.now ?? Date.now());
    if (route === undefined) return;
    const request = {
      location, participant: seat.participant, activity: formatActivityId(head.index), actor: head.actor,
      seat: asSeatRef(seat), route,
      artifact: input.artifact,
    } satisfies WakeRequest;
    if (input.transport.probe !== undefined) {
      try {
        const probe = await input.transport.probe(route);
        if (probe === false || typeof probe === 'object' && probe.outcome === 'not-capable') return;
      } catch { return; }
    }

    const claimToken = randomUUID();
    const leaseMs = input.timeoutMs ?? 5000;
    let snapshot: Currentness | undefined;
    await dispatchEffect({
      async claim() {
        const claim = await input.artifact.claimDelivery({ seat: request.seat, activity: request.activity, kind: 'wake',
          route: seat.wakeAddress, at: input.now ?? Date.now(), leaseMs, claimToken }).catch(() => ({ status: 'stale' as const }));
        return claim.status === 'acquired' ? { token: claimToken, ordinal: claim.attemptN } : undefined;
      },
      async current() {
        snapshot = undefined;
        snapshot = await currentness(input.artifact, request, input.now ?? Date.now());
        return snapshot.current;
      },
      async settle(claim, completion) {
        let fields: { signature?: string; message?: string; diagnostic?: unknown } = {};
        if (completion.reason === 'not-current') fields = {
          signature: 'pre_send_revalidation_failed',
          message: completion.phase === 'final' ? 'The notification changed before the final send check.'
            : snapshot === undefined ? 'Square delivery state could not be verified.' : 'The notification is no longer current.',
          diagnostic: snapshot ?? (completion.phase === 'final' ? { observationAvailable: false } : undefined),
        };
        else if (completion.reason === 'timeout') fields = { diagnostic: 'transport timeout' };
        else if (completion.reason === 'threw') fields = { diagnostic: completion.error instanceof Error ? completion.error.message : String(completion.error) };
        else if (completion.reason === 'not-capable') fields = {
          signature: 'transport_not_capable', diagnostic: (completion.data as { diagnostic?: unknown } | undefined)?.diagnostic,
        };
        else if (completion.reason === 'returned') fields = completion.data as typeof fields;
        return input.artifact.completeDelivery({ seat: request.seat, activity: request.activity, claimToken: claim.token,
          outcome: completion.outcome, at: Date.now(),
          ...(fields.signature === undefined ? {} : { signature: fields.signature }),
          ...(fields.message === undefined ? {} : { message: fields.message }),
          ...(fields.diagnostic === undefined ? {} : { diagnostic: safeJson(fields.diagnostic) }),
        }).catch(() => false);
      },
    }, async ({ claim, timeoutMs, beforeSend }) => {
      const outcome = await input.transport.attempt({ ...request, claimToken: claim.token, attemptN: claim.ordinal }, timeoutMs, beforeSend);
      return { outcome: outcome.outcome, data: outcome };
    }, { timeoutMs: leaseMs });
  };
  const groups = receivers.values();
  const settled = await Promise.allSettled(Array.from({ length: Math.min(4, receivers.size) }, async () => {
    for (const group of groups) for (const candidate of group) await dispatch(candidate);
  }));
  // Even an unexpected failure must drain siblings before the caller closes its artifact.
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
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
