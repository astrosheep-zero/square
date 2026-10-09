import type { EvidenceRecord, NativeDeliveryEvidence, PresenceRecord } from './host-ledger.js';
import type { WakeTransportPort } from './ports.js';
import { nameKey, type SquareState } from './model.js';
import { observeSessionPending, sessionInbox } from './inbox.js';
import { hostLedgerForEnv, withOwnershipClaimLock } from './registry.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { nativePendingPreview, presentationSuppressesWake, projectPresentationEvidence } from './square-projections.js';
import { presentPending } from './presentation-operations.js';
import { deliverPending } from './delivery-operations.js';
import { createWakeTransport } from './notifications.js';
import { publishWakeRoute } from './routes.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import { createNativeInputId, sendNativeText, type OpenCodeNativeSession } from './packages/agent-delivery/src/opencode-native.js';

const routeKind = 'opencode-server' as const;
type NativeRow = EvidenceRecord & { claimToken: string; nativeDelivery: Extract<NativeDeliveryEvidence, { harness: 'opencode' }> };
export interface OpenCodeContextMessage { readonly id?: string; readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }
const key = (location: string, participant: string, index: number) => `${location}\0${nameKey(participant)}\0${index}`;

/** The one native pending preview: the audience/catch/epoch fence before send and inside presentation. */
function preview(state: SquareState, owner: PresenceRecord, index: number) {
  return nativePendingPreview(state, { location: owner.location, routeKind, sessionId: owner.session, participant: owner.participant, actIndex: index, epoch: owner.epoch, address: { sessionId: owner.session }, cancelledThrough: owner.cancelledThrough, now: Date.now() });
}

function createOpenCodeWakeTransport(target: OpenCodeNativeSession, env: NodeJS.ProcessEnv, lifetime: AbortSignal): WakeTransportPort {
  const ledger = hostLedgerForEnv(env);
  return {
    probe: async (route) => !lifetime.aborted && route.kind === routeKind && route.sessionId === target.sessionId && route.address.sessionId === target.sessionId,
    async attempt(request, timeoutMs, beforeSend) {
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs)]);
      const deadline = Date.now() + timeoutMs;
      // Start the native call under the ownership fence, but await it OUTSIDE: prompt may
      // enter our context hook synchronously and that hook needs the same ownership lock.
      const started = await withOwnershipClaimLock(env, async () => {
        if (signal.aborted || request.route.sessionId !== target.sessionId || !request.claimToken
          || !await (beforeSend?.() ?? Promise.resolve(true))) return undefined;
        const owner = (await ledger.listPresence({ location: request.location, participant: request.participant, session: target.sessionId }))
          .find((binding) => binding.channel === 'opencode' && binding.epoch === request.route.epoch);
        const index = parseActivityId(request.activity);
        if (!owner || index === undefined) return undefined;
        const square = await openSquare(owner.location, { hostLedger: ledger, env, signal });
        try {
          const prepared = preview((await square.artifact.read(signal)).state, owner, index);
          if (!prepared) return undefined;
          const row: NativeRow & { routeKind: typeof routeKind } = { location: owner.location, participant: owner.participant, session: target.sessionId,
            activity: request.activity, kind: 'wake', outcome: 'dispatching', routeKind, attemptN: request.attemptN, claimToken: request.claimToken,
            nativeDelivery: { harness: 'opencode', epoch: owner.epoch ?? 0, inputId: createNativeInputId(), payload: prepared.payload } };
          if (!await ledger.prepareNativeWake(row) || !await (beforeSend?.() ?? Promise.resolve(true)) || signal.aborted
            || preview((await square.artifact.read(signal)).state, owner, index)?.payload !== prepared.payload) return undefined;
          return { sending: sendNativeText(target, prepared.payload, { inputId: row.nativeDelivery.inputId, delivery: 'steer',
            timeoutMs: Math.max(1, deadline - Date.now()), signal }) };
        } finally { await closeOpenSquare(square); }
      }, signal);
      if (!started) return { outcome: 'not-capable', diagnostic: 'OpenCode attention, binding or local delivery generation changed before send.' };
      const result = await started.sending;
      if (result.state === 'accepted') return { outcome: 'accepted' };
      if (result.state === 'unavailable') return { outcome: 'failed', unavailable: true, retainRoute: true, signature: result.code };
      return { outcome: 'unknown', signature: result.code };
    },
  };
}

/** Only the matching prepared primary context authorizes presentation, never admission. */
export async function observeOpenCodeContext(sessionId: string, messages: readonly OpenCodeContextMessage[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const ledger = hostLedgerForEnv(env);
  await withOwnershipClaimLock(env, async () => {
    if (signal.aborted) return;
    const rows = (await ledger.listEvidence({ kind: 'wake', session: sessionId })).filter((row): row is NativeRow =>
      row.nativeDelivery?.harness === 'opencode' && !!row.claimToken && ['dispatching', 'unknown', 'accepted'].includes(row.outcome));
    for (const row of rows) {
      if (signal.aborted || !messages.some((message) => message.id === row.nativeDelivery.inputId && message.role === 'user'
        && message.content.every((part) => part.type === 'text' && typeof part.text === 'string')
        && message.content.map((part) => part.text).join('') === row.nativeDelivery.payload)) continue;
      const owner = (await ledger.listPresence({ location: row.location, participant: row.participant, session: sessionId }))
        .find((binding) => binding.channel === 'opencode' && binding.epoch === row.nativeDelivery.epoch);
      const index = parseActivityId(row.activity);
      if (!owner || index === undefined) continue;
      const square = await openSquare(row.location, { hostLedger: ledger, env, signal });
      try {
        const prepared = preview((await square.artifact.read(signal)).state, owner, index);
        if (!prepared || prepared.payload !== row.nativeDelivery.payload) continue;
        const prior = await projectPresentationEvidence({ hostLedger: ledger, location: row.location, participant: row.participant, sessionId, activity: row.activity });
        if (presentationSuppressesWake(prior)) continue;
        await presentPending({ artifact: square.artifact, hostLedger: ledger, location: row.location, participant: row.participant, session: sessionId,
          activity: row.activity, sink: { present() {} }, markSeen: !prepared.clipped, signal,
          current: (state) => !signal.aborted && preview(state, owner, index)?.payload === row.nativeDelivery.payload });
      } finally { await closeOpenSquare(square); }
    }
  }, signal);
}

/** One existing observer and the existing dispatch owner; no second queue or evidence store. */
export async function receiveOpenCodePending(target: OpenCodeNativeSession, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const ledger = hostLedgerForEnv(env);
  const observer = await observeSessionPending(target.sessionId, env);
  const excluded = new Set<string>();
  const refreshExclusions = async () => {
    excluded.clear();
    const owners = await ledger.listPresence({ session: target.sessionId });
    for (const row of await ledger.listEvidence({ kind: 'wake', session: target.sessionId })) {
      const index = parseActivityId(row.activity);
      const current = owners.some((owner) => owner.location === row.location && nameKey(owner.participant) === nameKey(row.participant) && owner.epoch === row.nativeDelivery?.epoch);
      if (index !== undefined && (['accepted', 'unknown'].includes(row.outcome) || row.outcome === 'dispatching' && current && row.nativeDelivery?.harness === 'opencode')) excluded.add(key(row.location, row.participant, index));
    }
    for (const membership of await sessionInbox(target.sessionId, env, signal)) {
      const owner = owners.find((binding) => binding.location === membership.squarePath && nameKey(binding.participant) === nameKey(membership.name));
      for (const note of membership.notifications) if (note.actIndex <= (owner?.cancelledThrough ?? -1)) excluded.add(key(membership.squarePath, membership.name, note.actIndex));
    }
  };
  const transport = createWakeTransport([], ledger, Date.now, { [routeKind]: createOpenCodeWakeTransport(target, env, signal) });
  try {
    await refreshExclusions();
    let pending = await observer.wait(Infinity, { signal, excludeKeys: excluded });
    while (!signal.aborted && pending.length > 0) {
      let armed!: (value: boolean) => void;
      const ready = new Promise<boolean>((resolve) => { armed = resolve; });
      // Capture the next state edge BEFORE dispatch. Evidence failures alone do not retry.
      const next = observer.wait(Infinity, { signal, excludeKeys: excluded, skipImmediate: true, onChangeArmed: armed })
        .catch(() => { armed(false); return []; });
      if (!await ready || signal.aborted) break;
      for (const membership of pending) {
        const square = await openSquare(membership.squarePath, { hostLedger: ledger, env, signal });
        try {
          for (const note of membership.notifications) {
            if (signal.aborted || excluded.has(key(membership.squarePath, membership.name, note.actIndex))) continue;
            await deliverPending({ artifact: square.artifact, hostLedger: ledger, transport, location: square.location, activity: formatActivityId(note.actIndex), now: Date.now() });
          }
        } finally { await closeOpenSquare(square); }
      }
      await refreshExclusions();
      pending = await next;
    }
  } finally { observer.close(); }
}

export async function publishOpenCodeRoutes(sessionId: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  const ledger = hostLedgerForEnv(env);
  return withOwnershipClaimLock(env, async () => {
    const owners = (await ledger.listPresence({ session: sessionId })).filter((binding) => binding.channel === 'opencode');
    for (const owner of owners) {
      const square = await openSquare(owner.location, { hostLedger: ledger, env, signal });
      try { await publishWakeRoute(square.artifact, { location: owner.location, participant: owner.participant, sessionId, channel: 'opencode',
        kind: routeKind, address: { sessionId }, epoch: owner.epoch }, { requireCurrentSession: true }); }
      finally { await closeOpenSquare(square); }
    }
    return owners.length > 0;
  }, signal);
}
