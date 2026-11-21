import { createHash } from 'node:crypto';
import { renderDeliveryReminder } from '../../delivery-frame.js';
import { DeliveryLedger, type DeliveryTransport, type TransportOutcome } from '../../delivery-ledger.js';
import { retainDeliveryLedger } from '../../delivery-lifetime.js';
import { harnessOwner, decodeHarnessOwner } from '../../owner.js';
import { attachDeliverySessionRoutes, detachDeliverySession, markDeliverySessionDeleted } from '../../session-lifecycle.js';

const routeKind = 'opencode-server';
const ownerFor = (sessionId: string) => harnessOwner({ channel: 'opencode', session: sessionId });
const open = (env: NodeJS.ProcessEnv, signal?: AbortSignal) => DeliveryLedger.open({ location: env.SQUARE_DELIVERY, signal });
const payloadHash = (payload: string) => createHash('sha256').update(payload).digest('hex');
export interface OpenCodeContextMessage { readonly id?: string; readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }

export async function listOpenCodeSessions(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<readonly string[]> {
  signal ??= AbortSignal.timeout(5000);
  const ledger = await open(env, signal);
  try {
    return (await ledger.sessions(signal)).flatMap(session => {
      const coordinate = decodeHarnessOwner(session.owner);
      return session.state !== 'deleted' && coordinate?.channel === 'opencode' ? [coordinate.session] : [];
    });
  } finally { await ledger.close(); }
}

/** The file observer is a hint; callers must always reread the ledger after an edge. */
export async function observeOpenCodeSessions(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  signal ??= AbortSignal.timeout(5000);
  const ledger = await open(env, signal);
  try {
    const observer = await ledger.observe(ownerFor('discovery'));
    return { observer, close: async () => { observer.close(); await ledger.close(); } };
  } catch (error) { await ledger.close(); throw error; }
}

export async function publishOpenCodeAddress(sessionId: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | undefined> {
  const session = await attachDeliverySessionRoutes(ownerFor(sessionId), env, [{ kind: routeKind, address: { sessionId } }], signal);
  return session ? session.generation : undefined;
}

export async function currentOpenCodeGeneration(sessionId: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | undefined> {
  signal ??= AbortSignal.timeout(5000);
  const ledger = await open(env, signal);
  try { return (await ledger.session(ownerFor(sessionId), signal))?.generation; } finally { await ledger.close(); }
}

export async function detachOpenCodeSession(sessionId: string, generation: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  signal ??= AbortSignal.timeout(5000);
  await detachDeliverySession(ownerFor(sessionId), generation, env, signal);
}
export async function endOpenCodeSession(sessionId: string, generation: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  signal ??= AbortSignal.timeout(5000);
  await markDeliverySessionDeleted(ownerFor(sessionId), generation, env, signal);
}
export async function cancelOpenCodeDeliveries(sessionId: string, generation: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  signal ??= AbortSignal.timeout(5000);
  const ledger = await open(env, signal);
  try { return await ledger.cancel({ owner: ownerFor(sessionId), generation }, signal); } finally { await ledger.close(); }
}

function textMessage(message: OpenCodeContextMessage): string | undefined {
  if (message.role !== 'user' || message.id === undefined || !message.content.every(part => part.type === 'text' && typeof part.text === 'string')) return undefined;
  return message.content.map(part => part.text!).join('');
}

/** Confirmation is observer-level: another host plugin may subsequently remove the message. */
export async function observeOpenCodeContext(sessionId: string, generation: string, messages: readonly OpenCodeContextMessage[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const observed = new Map(messages.flatMap(message => {
    const text = textMessage(message);
    return text === undefined ? [] : [[message.id!, payloadHash(text)] as const];
  }));
  if (!observed.size || signal.aborted) return;
  const ledger = await open(env, signal);
  try {
    for (const attempt of await ledger.handoffs(ownerFor(sessionId), { generation }, signal)) {
      if (signal.aborted) return;
      const { correlation } = attempt;
      if (attempt.routeKind === routeKind && correlation.token === attempt.token && correlation.messageId !== undefined
        && correlation.payloadHash !== undefined && observed.get(correlation.messageId) === correlation.payloadHash)
        await ledger.observePresentation({ token: attempt.token, owner: ownerFor(sessionId), generation, routeKind, payloadHash: correlation.payloadHash }, { requireCurrent: true }, signal);
    }
  } finally { await ledger.close(); }
}

interface Receiver { readonly abort: AbortController; readonly running: Promise<void>; readonly generation: string; settled: boolean }
export type OpenCodeReceiverMode = 'immediate' | 'coordinated';
export interface OpenCodeReceivers {
  readonly signal: AbortSignal;
  /** Begin reconciliation only after the caller's native hooks and events are registered. */
  start(): void;
  refresh(id?: string): Promise<void>;
  context(id: string, read: () => readonly OpenCodeContextMessage[]): Promise<void>;
  interrupt(id: string, mode: OpenCodeReceiverMode): Promise<void>;
  deleted(id: string, mode: OpenCodeReceiverMode): Promise<void>;
  moved(id: string): Promise<void>;
  dispose(extra?: Promise<void>): Promise<void>;
}

/** One receiver lifecycle for both native plugins; `select` owns version-specific eligibility. */
export async function startOpenCodeReceivers(env: NodeJS.ProcessEnv, select: (id: string, lifetime: AbortSignal) => Promise<((receiverSignal: AbortSignal) => DeliveryTransport) | undefined>): Promise<OpenCodeReceivers> {
  const lifetime = new AbortController();
  const discovery = await observeOpenCodeSessions(env, lifetime.signal);
  const receivers = new Map<string, Receiver>(); // Operational handles only; presence owns membership.
  const terminal = new Set<string>();
  const interrupting = new Set<string>();
  const cancellationFailed = new Set<string>();
  let ready = false;
  let coordinating = Promise.resolve();
  const coordinate = (operation: () => Promise<void>) => {
    const task = coordinating.then(() => lifetime.signal.aborted ? undefined : operation());
    coordinating = task.catch(() => {}); // Optional Square hooks must never fail primary request preparation.
    return coordinating;
  };
  const stop = (id: string) => {
    const receiver = receivers.get(id);
    receiver?.abort.abort();
    receivers.delete(id);
    return receiver?.running;
  };
  const reconcile = async (active?: string) => {
    if (!ready) return;
    const candidates = new Set(await listOpenCodeSessions(env, lifetime.signal));
    if (active) candidates.add(active);
    for (const id of candidates) {
      if (lifetime.signal.aborted) return;
      if (interrupting.has(id) || cancellationFailed.has(id)) continue;
      const factory = terminal.has(id) ? undefined : await select(id, lifetime.signal);
      if (!factory || terminal.has(id)) {
        const captured = receivers.get(id);
        stop(id);
        if (captured) await detachOpenCodeSession(id, captured.generation, env, lifetime.signal);
        continue;
      }
      const existing = receivers.get(id);
      if (existing?.settled === false || interrupting.has(id)) continue;
      const generation = existing?.generation ?? await publishOpenCodeAddress(id, env, lifetime.signal);
      if (!generation) { stop(id); continue; }
      if (terminal.has(id) || interrupting.has(id) || lifetime.signal.aborted) { await detachOpenCodeSession(id, generation, env); continue; }
      const abort = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, abort.signal]);
      const receiver: Receiver = { abort, generation, settled: false,
        running: receiveOpenCodePending(id, generation, factory(signal), env, signal).catch(() => {}).finally(() => { receiver.settled = true; }) };
      receivers.set(id, receiver);
    }
    for (const id of receivers.keys()) if (!candidates.has(id)) stop(id);
  };
  const refresh = (id?: string) => coordinate(() => reconcile(id));
  const context = (id: string, read: () => readonly OpenCodeContextMessage[]) => coordinate(async () => {
    if (terminal.has(id)) return;
    await reconcile(id);
    const receiver = receivers.get(id);
    if (!receiver || terminal.has(id) || lifetime.signal.aborted) return;
    await observeOpenCodeContext(id, receiver.generation, read(), env, AbortSignal.any([lifetime.signal, receiver.abort.signal])).catch(() => {});
  });
  const interrupt = (id: string, mode: OpenCodeReceiverMode): Promise<void> => {
    if (interrupting.has(id) || !receivers.has(id)) return Promise.resolve();
    interrupting.add(id);
    receivers.get(id)?.abort.abort();
    const capture = () => { const receiver = receivers.get(id); stop(id); return receiver; };
    const captured = mode === 'immediate' ? capture() : undefined;
    return coordinate(async () => {
      const receiver = mode === 'immediate' ? captured : capture();
      if (!receiver) return; // A missing handle stays latched: no fresh attachment or cancel fallback.
      await receiver.running;
      try {
        if (!await cancelOpenCodeDeliveries(id, receiver.generation, env)) throw new Error('OpenCode cancellation fence lost');
      } catch (error) {
        cancellationFailed.add(id);
        await detachOpenCodeSession(id, receiver.generation, env).catch(() => {});
        throw error;
      } finally { interrupting.delete(id); }
      await reconcile(id); // Occupies this queue: `refresh` would deadlock.
    });
  };
  const deleted = (id: string, mode: OpenCodeReceiverMode): Promise<void> => {
    if (mode === 'immediate') terminal.add(id);
    const capture = () => { const receiver = receivers.get(id); stop(id); return receiver; };
    const captured = mode === 'immediate' ? capture() : undefined;
    return coordinate(async () => {
      const generation = (mode === 'immediate' ? captured : capture())?.generation ?? await currentOpenCodeGeneration(id, env);
      if (generation) await endOpenCodeSession(id, generation, env);
    });
  };
  const moved = (id: string) => coordinate(async () => {
    const receiver = receivers.get(id);
    stop(id);
    if (receiver) await detachOpenCodeSession(id, receiver.generation, env, lifetime.signal);
    await reconcile();
  });
  let presenceLoop: Promise<void> | undefined;
  const start = () => {
    ready = true;
    presenceLoop ??= (async () => {
      while (!lifetime.signal.aborted) {
        const baseline = discovery.observer.generation;
        await coordinate(() => reconcile());
        await discovery.observer.hinted(baseline, 2000, lifetime.signal);
      }
    })().catch(() => {});
  };
  let disposal: Promise<void> | undefined;
  const dispose = (extra?: Promise<void>) => disposal ??= (async () => {
    lifetime.abort();
    const captured = [...receivers.entries()];
    const tasks: (Promise<void> | undefined)[] = [presenceLoop, coordinating, ...captured.map(([id]) => stop(id))];
    if (extra) tasks.push(extra);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled(tasks), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    await Promise.allSettled(captured.map(([id, receiver]) => detachOpenCodeSession(id, receiver.generation, env)));
    await discovery.close();
    // Instance unload is not session deletion: retain memberships and uncertain correlations.
  })();
  return { signal: lifetime.signal, start, refresh, context, interrupt, deleted, moved, dispose };
}

/** Square side of the send fence; `invoke` owns only the version-specific native effect. */
export function openCodeTransport(sessionId: string, lifetime: AbortSignal, makeId: () => string, invoke: (send: { readonly messageId: string; readonly text: string; readonly signal: AbortSignal; readonly deadline: number }) => Promise<TransportOutcome>): DeliveryTransport {
  return {
    kind: routeKind,
    async send(card, address, context) {
      const signal = AbortSignal.any([lifetime, context.signal]);
      if (address.sessionId !== sessionId || signal.aborted) return 'not-capable';
      const messageId = makeId();
      const text = renderDeliveryReminder([card.text], { tagged: true });
      if (!await context.prepare({ token: context.token, messageId, payloadHash: payloadHash(text) }) || signal.aborted
        || !await context.beforeSend() || signal.aborted || Date.now() >= context.deadline) return 'not-capable';
      return invoke({ messageId, text, signal, deadline: context.deadline });
    },
  };
}

export async function receiveOpenCodePending(sessionId: string, generation: string, transport: DeliveryTransport, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const owner = ownerFor(sessionId);
  const ledger = await open(env, signal);
  const lifetime = retainDeliveryLedger(ledger);
  const observer = await ledger.observe(owner);
  try {
    while (!signal.aborted) {
      const baseline = observer.generation;
      for (const card of await ledger.pending(owner, { generation }, signal)) {
        if (signal.aborted) return;
        lifetime.track(await ledger.dispatchHandoff(owner, card.key, transport, { generation, timeoutMs: 5000, signal }));
      }
      if (!signal.aborted) await observer.hinted(baseline, 2000, signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { observer.close(); await lifetime.close(); }
}
