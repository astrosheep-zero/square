import { createHash } from 'node:crypto';
import { createArtifactPort } from '../../artifact.js';
import { deliverPending } from '../../delivery-operations.js';
import { nativePendingPreview, observeSessionPending, projectSessionSeats } from '../../inbox.js';
import { automaticWakeEligible, presentationBlocksWake } from '../../delivery.js';
import { type Seat } from '../../model.js';
import { harnessOwner, decodeHarnessOwner } from '../../owner.js';
import type { SquareRead, WakeRequest, WakeTransportPort } from '../../ports.js';
import { formatActivityId, parseActivityId } from '../../square-core.js';
import { indexedSquareEntries } from '../../square-index.js';
import { asSeatRef } from '../../seats.js';
import { restoreSessionSeats } from '../../session-lifecycle.js';
import { presentPending } from '../../presentation-operations.js';
import { createNativeInputId, sendNativeText, type OpenCodeNativeSession } from '../../packages/agent-delivery/src/opencode-native.js';

const routeKind = 'opencode-server' as const;
const ownerFor = (sessionId: string) => harnessOwner({ channel: 'opencode', session: sessionId });
const payloadHash = (payload: string) => createHash('sha256').update(payload).digest('hex');
export interface OpenCodeContextMessage { readonly id?: string; readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }

function preview(facts: SquareRead, location: string, captured: Pick<Seat, 'participant' | 'owner' | 'generation'>, index: number) {
  const seat = facts.seat(captured.participant);
  if (seat === undefined || seat.attachment !== 'attached' || seat.generation !== captured.generation || seat.owner !== captured.owner) return undefined;
  const wake = seat.wakeAddress;
  if (wake?.kind !== routeKind) return undefined;
  return nativePendingPreview(facts, {
    location, routeKind, generation: seat.generation, participant: seat.participant,
    actIndex: index, address: wake.address, now: Date.now(),
  });
}

export async function indexedOpenCodeSessions(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  return [...new Set((await indexedSquareEntries({ }, env)).flatMap((entry) => {
    const coordinate = decodeHarnessOwner(entry.owner);
    return coordinate?.channel === 'opencode' ? [coordinate.session] : [];
  }))];
}

export async function discoverOpenCodeSeats(sessionId: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return projectSessionSeats({ owner: ownerFor(sessionId), env }, signal);
}

function sameSeat(left: Seat | undefined, right: Seat): boolean {
  return left !== undefined && left.attachment === 'attached' && left.generation === right.generation && left.owner === right.owner;
}

function createOpenCodeWakeTransport(target: OpenCodeNativeSession, lifetime: AbortSignal): WakeTransportPort {
  return {
    probe: async (route) => !lifetime.aborted && route.kind === routeKind
      && route.address.sessionId === target.sessionId,
    async attempt(request: WakeRequest, timeoutMs: number, beforeSend) {
      const index = parseActivityId(request.activity);
      const artifact = request.artifact;
      if (artifact === undefined || request.claimToken === undefined || index === undefined
        || request.route.kind !== routeKind || request.route.address.sessionId !== target.sessionId) {
        return { outcome: 'not-capable', diagnostic: 'OpenCode attention has no matching artifact claim or session.' };
      }
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs)]);
      const started = Date.now();
      if (signal.aborted || !await beforeSend())
        return { outcome: 'not-capable', diagnostic: 'OpenCode attention changed before send.' };
      const { value: prepared } = await artifact.read((facts) => preview(facts, request.location, request.seat, index), signal);
      if (prepared === undefined) return { outcome: 'not-capable', diagnostic: 'OpenCode attention is no longer current.' };
      const inputId = createNativeInputId();
      const correlation = { harness: 'opencode' as const, token: inputId, payloadHash: payloadHash(prepared.payload) };
      if (!await artifact.prepareDelivery({ seat: request.seat, claimToken: request.claimToken, correlation }, signal))
        return { outcome: 'not-capable', diagnostic: 'OpenCode delivery claim is no longer current.' };
      const fresh = await artifact.read((facts) => preview(facts, request.location, request.seat, index), signal);
      if (fresh.value === undefined || payloadHash(fresh.value.payload) !== correlation.payloadHash)
        return { outcome: 'not-capable', diagnostic: 'OpenCode attention changed before native send.' };
      if (signal.aborted || !await beforeSend())
        return { outcome: 'not-capable', diagnostic: 'OpenCode attention was consumed before send.' };
      const result = await sendNativeText(target, prepared.payload, {
        inputId, delivery: 'steer', timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), signal,
      });
      if (result.state === 'accepted') return { outcome: 'accepted' };
      if (result.state === 'unavailable') return { outcome: 'failed', signature: result.code };
      return { outcome: 'unknown', signature: result.code };
    },
  };
}

function textMessage(message: OpenCodeContextMessage): string | undefined {
  if (message.role !== 'user' || message.id === undefined || !message.content.every((part) => part.type === 'text' && typeof part.text === 'string')) return undefined;
  return message.content.map((part) => part.text!).join('');
}

/** The exact prepared native message can authorize artifact-backed presentation once. */
export async function observeOpenCodeContext(sessionId: string, messages: readonly OpenCodeContextMessage[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const observed = new Map(messages.flatMap((message) => {
    const text = textMessage(message);
    return text === undefined ? [] : [[message.id!, payloadHash(text)] as const];
  }));
  if (observed.size === 0 || signal.aborted) return;
  for (const { location, seat } of await discoverOpenCodeSeats(sessionId, env, signal)) {
    if (signal.aborted) return;
    const artifact = createArtifactPort(location, undefined, signal);
    try {
      const { value: matches } = await artifact.read((facts) => {
        if (!sameSeat(facts.seat(seat.participant), seat)) return [];
        return facts.deliveryEvidence(seat.participant, seat.generation).flatMap((evidence) => {
          const token = evidence.correlation?.harness === 'opencode' ? evidence.correlation.token : undefined;
          const hash = token === undefined ? undefined : observed.get(token);
          const index = parseActivityId(evidence.activity);
          if (token === undefined || hash === undefined || evidence.claimToken === undefined || index === undefined
            || !['dispatching', 'unknown', 'accepted'].includes(evidence.outcome)
            || evidence.correlation?.payloadHash !== hash) return [];
          const prepared = preview(facts, location, seat, index);
          if (prepared === undefined || payloadHash(prepared.payload) !== hash
            || presentationBlocksWake(facts.deliveryEvidence(seat.participant, seat.generation, evidence.activity), Date.now())) return [];
          return [{ evidence, index, hash, clipped: prepared.clipped }];
        });
      }, signal);
      for (const { evidence, index, hash, clipped } of matches) {
        if (signal.aborted || evidence.claimToken === undefined) return;
        await presentPending({ artifact, location, participant: seat.participant,
          activity: formatActivityId(index), seat: asSeatRef(seat), sink: { present() {} }, markSeen: !clipped, signal,
          current: (facts) => {
            const current = facts.seat(seat.participant);
            const prepared = current === undefined || !sameSeat(current, seat) ? undefined : preview(facts, location, seat, index);
            const correlation = facts.deliveryByToken(evidence.claimToken!);
            return prepared !== undefined && payloadHash(prepared.payload) === hash
              && correlation?.correlation?.harness === 'opencode'
              && correlation.correlation.token !== undefined
              && correlation.correlation.payloadHash === hash;
          },
        });
      }
    } finally { await artifact.close(); }
  }
}

/** The native receiver owns no claims outside the artifact; HOME is used only for discovery. */
export async function receiveOpenCodePending(target: OpenCodeNativeSession, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const observer = await observeSessionPending(ownerFor(target.sessionId), env);
  const transport = createOpenCodeWakeTransport(target, signal);
  let waiting: ReturnType<typeof observer.wait> | undefined;
  try {
    while (!signal.aborted) {
      const armed = new Promise<boolean>((resolve) => {
        waiting = observer.wait(Infinity, { signal, skipImmediate: true, onChangeArmed: resolve });
        void waiting.catch(() => resolve(false));
      });
      if (!await armed) { await waiting; break; }
      for (const membership of await observer.read({ signal })) {
        const { location, seat } = membership;
        if (signal.aborted) return;
        const artifact = createArtifactPort(location, undefined, signal);
        try {
          const { value: notifications } = await artifact.read((facts) => {
            if (!sameSeat(facts.seat(seat.participant), seat)) return [];
            return membership.notifications.filter((note) => automaticWakeEligible(
              facts.deliveryEvidence(seat.participant, seat.generation, formatActivityId(note.actIndex)), Date.now()));
          }, signal);
          for (const note of notifications) {
            if (signal.aborted) return;
            await deliverPending({ artifact, transport, location, activity: formatActivityId(note.actIndex), now: Date.now() });
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          // A candidate that became unreadable cannot authorize sending; the shared observer
          // keeps its subscription and will reconsider the artifact after repair.
        } finally { await artifact.close(); }
      }
      await waiting;
      waiting = undefined;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    observer.close();
    await waiting?.catch(() => {});
  }
}

/** Publish the native address into current artifact seats; the legacy route projection is not read. */
export async function publishOpenCodeAddress(sessionId: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  await restoreSessionSeats(ownerFor(sessionId), env, { kind: routeKind, address: { sessionId } }, signal);
  const seats = (await discoverOpenCodeSeats(sessionId, env, signal)).filter(({ seat }) => seat.attachment === 'attached');
  for (const { location, seat } of seats) {
    if (signal.aborted) return false;
    const artifact = createArtifactPort(location, undefined, signal);
    try {
      await artifact.transactAs({ kind: 'participant', seat: asSeatRef(seat) }, (facts) =>
        facts.updateWakeAddress(asSeatRef(seat), { kind: routeKind, address: { sessionId } }));
    } finally { await artifact.close(); }
  }
  return seats.length > 0;
}

export async function cancelOpenCodeDeliveries(sessionId: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  for (const { location, seat } of await discoverOpenCodeSeats(sessionId, env, signal)) {
    if (signal.aborted) return;
    if (seat.attachment !== 'attached') continue;
    const artifact = createArtifactPort(location, undefined, signal);
    try {
      const { value: through } = await artifact.read((facts) => facts.header().lastActIndex, signal);
      if (through >= 0) await artifact.cancelDeliveries(asSeatRef(seat), through, signal);
    } finally { await artifact.close(); }
  }
}

export async function endOpenCodeSession(sessionId: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  for (const { location, seat } of await discoverOpenCodeSeats(sessionId, env, signal)) {
    if (signal.aborted) return;
    const { Square } = await import('../../square-api.js');
    const square = await Square.at({ path: location, env });
    try { await square.endHeld(seat.participant, { owner: seat.owner, generation: seat.generation }); }
    finally { await square.close(); }
  }
}
