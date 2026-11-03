import { createHash } from 'node:crypto';
import { squareWakeProjection } from '../../wake-preview.js';
import { channelArtifact, createArtifactPort } from '../../artifact.js';
import { deliverPending } from '../../delivery-operations.js';
import { nativePendingSource, observeSessionPending, projectSessionSeats } from '../../inbox.js';
import { automaticWakeEligible, nativePendingHead, presentationBlocksWake } from '../../delivery.js';
import { type Seat } from '../../model.js';
import { harnessOwner, decodeHarnessOwner } from '../../owner.js';
import type { WakeRequest, WakeTransportPort } from '../../ports.js';
import { formatMessageId, parseMessageId } from '../../message.js';
import { indexedSquareEntries } from '../../square-index.js';
import { asSeatRef } from '../../seats.js';
import { restoreSessionSeats } from '../../session-lifecycle.js';
import { presentPending } from '../../presentation-operations.js';

const routeKind = 'opencode-server' as const;
const ownerFor = (sessionId: string) => harnessOwner({ channel: 'opencode', session: sessionId });
const payloadHash = (payload: string) => createHash('sha256').update(payload).digest('hex');
export interface OpenCodeContextMessage { readonly id?: string; readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }

/** Prepare durable correlation under the same claim and final-send fences for both hosts. */
export async function prepareOpenCodeWake(request: WakeRequest, sessionId: string, signal: AbortSignal,
  beforeSend: () => Promise<boolean>, createId: () => string): Promise<{ inputId: string; payload: string } | undefined> {
  const presentation = request.presentation;
  if (request.claimToken === undefined || parseMessageId(request.message) === undefined || presentation === undefined
    || request.route.kind !== routeKind || request.route.address.sessionId !== sessionId || signal.aborted || !await beforeSend() || signal.aborted) return undefined;
  const inputId = createId();
  if (!await request.channel.prepare({ correlation: { harness: 'opencode', token: inputId, payloadHash: payloadHash(presentation.payload) },
    coverage: presentation.coverage, ...(presentation.description === undefined ? {} : { description: presentation.description }) }, signal)) return undefined;
  if (signal.aborted || !await beforeSend() || signal.aborted) return undefined;
  return { inputId, payload: presentation.payload };
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
          const index = parseMessageId(evidence.message), now = Date.now();
          if (token === undefined || hash === undefined || evidence.claimToken === undefined || index === undefined
            || evidence.route === undefined || !['dispatching', 'unknown', 'accepted'].includes(evidence.outcome)
            || evidence.correlation?.payloadHash !== hash
            || evidence.route.kind !== routeKind
            || presentationBlocksWake(facts.deliveryEvidence(seat.participant, seat.generation, evidence.message), now)) return [];
          const source = nativePendingSource(facts, { location, participant: seat.participant, generation: seat.generation,
            owner: seat.owner, index, route: evidence.route, now });
          if (source === undefined) return [];
          return [{ evidence, index, hash, clipped: evidence.coverage === 'clipped' }];
        });
      }, signal);
      for (const { evidence, index, hash, clipped } of matches) {
        if (signal.aborted || evidence.claimToken === undefined) return;
        await presentPending({ artifact, location, participant: seat.participant,
          message: formatMessageId(index), seat: asSeatRef(seat), observationOf: evidence.claimToken, sink: { present() {} }, markSeen: !clipped, signal,
          current: (facts) => {
            const correlation = facts.deliveryByToken(evidence.claimToken!);
            return nativePendingHead(facts, { location, participant: seat.participant, generation: seat.generation,
                owner: seat.owner, index, route: evidence.route!, now: Date.now() }) !== undefined
              && ['dispatching', 'unknown', 'accepted'].includes(correlation?.outcome ?? '')
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
export async function receiveOpenCodePending(sessionId: string, transport: WakeTransportPort, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const observer = await observeSessionPending(ownerFor(sessionId), env);
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
              facts.deliveryEvidence(seat.participant, seat.generation, formatMessageId(note.messageIndex)), Date.now()));
          }, signal);
          for (const note of notifications) {
            if (signal.aborted) return;
            await deliverPending({ artifact: channelArtifact(artifact), preparePresentation: squareWakeProjection(artifact), transport, location, message: formatMessageId(note.messageIndex), now: Date.now() });
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
      const { value: through } = await artifact.read((facts) => facts.channel.header().lastMessageIndex, signal);
      if (through >= 0) await artifact.cancelDeliveries(asSeatRef(seat), through, signal);
    } finally { await artifact.close(); }
  }
}

export async function endOpenCodeSession(sessionId: string, env: NodeJS.ProcessEnv, signal: AbortSignal, captured?: Awaited<ReturnType<typeof discoverOpenCodeSeats>>): Promise<void> {
  for (const { location, seat } of captured ?? await discoverOpenCodeSeats(sessionId, env, signal)) {
    if (signal.aborted) return;
    const { Square } = await import('../../square-api.js');
    const square = await Square.at({ path: location, env });
    try { await square.endHeld(seat.participant, { owner: seat.owner, generation: seat.generation }); }
    finally { await square.close(); }
  }
}
