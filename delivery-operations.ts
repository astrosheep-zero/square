import { randomUUID } from 'node:crypto';
import { formatMessageId, parseMessageId } from './message.js';
import type { WakeRoute, JsonValue } from './channel-values.js';
import type { ChannelArtifact, ChannelRead, EndpointFact, MessageHead } from './channel-ports.js';
import type { WakeProjection, WakeProjectionContext, WakeRequest, WakeTransportPort } from './channel-transport.js';

interface DeliverPendingInput {
  readonly artifact: ChannelArtifact;
  readonly preparePresentation?: WakeProjection;
  readonly transport: WakeTransportPort;
  readonly location: string;
  readonly timeoutMs?: number;
  readonly now?: number;
  readonly message?: string | number;
}
import { pendingAddresses, pendingHeadAt, pendingMessageHeads, presentationBlocksWake } from './channel-delivery.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { dispatchEffect } from './delivery-effects.js';
import { projectChannelNotification, renderSquareReminder } from './channel-presentation.js';

/** Standalone Channel projection; final send currentness is still checked by the dispatcher. */
export async function channelWakePreview(artifact: ChannelArtifact, request: WakeProjectionContext, signal?: AbortSignal): Promise<NonNullable<WakeRequest['presentation']> | undefined> {
  const index = parseMessageId(request.message);
  if (index === undefined) return undefined;
  return (await artifact.read(facts => {
    const seat = facts.endpoint(request.participant);
    const now = Date.now();
    if (seat === undefined || seat.attachment !== 'attached' || seat.owner !== request.seat.owner
      || seat.generation !== request.seat.generation || pendingHeadAt(facts, request.participant, index, now) === undefined
      || deliveryDeferralExpiry(facts, request.seat, index, now) !== undefined) return undefined;
    const item = facts.message(index);
    if (item === undefined) return undefined;
    const projected = projectChannelNotification({ squarePath: request.location, recipient: request.participant,
      actor: item.from, body: item.body, ...(item.preview === undefined ? {} : { preview: item.preview }) });
    return { payload: renderSquareReminder([projected.text]), coverage: projected.clipped ? 'clipped' as const : 'full' as const };
  }, signal)).value;
}

function routeFor(location: string, seat: { participant: string; attachment: 'attached' | 'detached'; wakeAddress?: { kind: WakeRoute['kind']; address: Readonly<Record<string, string>> } }, now: number): WakeRoute | undefined {
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

async function currentness(artifact: ChannelArtifact, request: WakeProjectionContext, now: number): Promise<Currentness> {
  const index = parseMessageId(request.message)!;
  const { value } = await artifact.read((facts) => {
    const currentSeat = facts.endpoint(request.participant);
    const seatCurrent = currentSeat !== undefined && currentSeat.attachment === 'attached' && currentSeat.generation === request.seat.generation
      && currentSeat.owner === request.seat.owner
      && currentSeat.wakeAddress?.kind === request.route.kind
      && Object.keys(currentSeat.wakeAddress.address).length === Object.keys(request.route.address).length
      && Object.entries(currentSeat.wakeAddress.address).every(([key, val]) => request.route.address[key] === val);
    const head = pendingHeadAt(facts, request.participant, index, now);
    const activityPending = seatCurrent && head !== undefined;
    const cancelledThrough = facts.cancelledThrough(request.participant, request.seat.generation);
    const cancelled = cancelledThrough !== undefined && index <= cancelledThrough;
    const evidence = facts.deliveryEvidence(request.participant, request.seat.generation, formatMessageId(index));
    const presented = presentationBlocksWake(evidence, now);
    const deferred = deliveryDeferralExpiry(facts, request.seat, index, now) !== undefined;
    return { current: activityPending && !cancelled && !presented && !deferred, activityPending, seatCurrent, cancelled, presented };
  });
  return value;
}

interface Candidate {
  readonly seat: EndpointFact;
  readonly head: MessageHead;
}

async function candidates(artifact: ChannelArtifact, requested?: number, now = Date.now()): Promise<Candidate[]> {
  const { value } = await artifact.read((facts: ChannelRead) => {
    const heads = requested === undefined
      ? facts.endpoints().filter(endpoint => endpoint.attachment === 'attached').flatMap(endpoint => pendingMessageHeads(facts, endpoint.participant, now))
      : pendingAddresses(facts, requested, now);
    return heads.flatMap(head => {
      const seat = facts.endpoint(head.recipient);
      return seat === undefined || seat.attachment !== 'attached' || deliveryDeferralExpiry(facts, seat, head.index, now) !== undefined
        ? [] : [{ seat, head }];
    });
  });
  return value;
}

function safeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(safeJson);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, safeJson(item)]));
  return String(value);
}

export async function deliverPending(input: DeliverPendingInput): Promise<void> {
  // The resource owner supplies its identity; delivery does not interpret it as a file.
  const location = input.location;
  const named = input.message;
  const requested = named === undefined ? undefined : typeof named === 'number' ? named : parseMessageId(named);
  if (named !== undefined && requested === undefined) return;

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
      location, participant: seat.participant, message: formatMessageId(head.index), actor: head.from,
      seat: { participant: seat.participant, owner: seat.owner, generation: seat.generation }, route,
    } satisfies WakeProjectionContext;
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
        const claim = await input.artifact.claimDelivery({ seat: request.seat, message: request.message, kind: 'wake',
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
        return input.artifact.completeDelivery({ seat: request.seat, message: request.message, claimToken: claim.token,
          outcome: completion.outcome, at: Date.now(),
          ...(fields.signature === undefined ? {} : { signature: fields.signature }),
          ...(fields.message === undefined ? {} : { messageText: fields.message }),
          ...(fields.diagnostic === undefined ? {} : { diagnostic: safeJson(fields.diagnostic) }),
        }).catch(() => false);
      },
    }, async ({ claim, deadline, beforeSend }) => {
      const { location, participant, message, actor, seat, route } = request;
      const prepared = input.preparePresentation === undefined
        ? await channelWakePreview(input.artifact, request)
        : await input.preparePresentation({ location, participant, message, actor, seat, route });
      if (prepared === undefined)
        return { outcome: 'not-capable', data: { diagnostic: 'The pending presentation is no longer current.' } };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { outcome: 'not-capable', data: { diagnostic: 'The presentation budget elapsed before transport.' } };
      const presentation = prepared;
      const preparationSeat = Object.freeze({ ...request.seat });
      const channel: WakeRequest['channel'] = { prepare: (details, signal) => input.artifact.prepareDelivery({
        seat: preparationSeat, claimToken: claim.token, correlation: details.correlation,
        coverage: details.coverage, description: details.description,
      }, signal) };
      const outcome = await input.transport.attempt({ ...request, seat: { ...request.seat }, channel, claimToken: claim.token, attemptN: claim.ordinal,
        ...(presentation === undefined ? {} : { presentation }) }, remaining, beforeSend);
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
  readonly artifact: ChannelArtifact;
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
