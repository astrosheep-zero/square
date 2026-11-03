import { createHash } from 'node:crypto';
import { DeliveryLedger, type DeliveryTransport } from '../../delivery-ledger.js';
import { retainDeliveryLedger } from '../../delivery-lifetime.js';
import { harnessOwner, decodeHarnessOwner } from '../../owner.js';
import { attachDeliverySessionRoutes, detachDeliverySession, markDeliverySessionDeleted } from '../../session-lifecycle.js';

const routeKind = 'opencode-server';
const ownerFor = (sessionId: string) => harnessOwner({ channel: 'opencode', session: sessionId });
const open = (env: NodeJS.ProcessEnv) => DeliveryLedger.open(env.SQUARE_DELIVERY ? { location: env.SQUARE_DELIVERY } : {});
const payloadHash = (payload: string) => createHash('sha256').update(payload).digest('hex');
export interface OpenCodeContextMessage { readonly id?: string; readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }

export async function listOpenCodeSessions(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const ledger = await open(env);
  try {
    return (await ledger.sessions()).flatMap(session => {
      const coordinate = decodeHarnessOwner(session.owner);
      return session.state !== 'deleted' && coordinate?.channel === 'opencode' ? [coordinate.session] : [];
    });
  } finally { await ledger.close(); }
}

/** The file observer is a hint; callers must always reread the ledger after an edge. */
export async function observeOpenCodeSessions(env: NodeJS.ProcessEnv) {
  const ledger = await open(env);
  const observer = await ledger.observe(ownerFor('discovery'));
  return { observer, close: async () => { observer.close(); await ledger.close(); } };
}

export async function publishOpenCodeAddress(sessionId: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | undefined> {
  const session = await attachDeliverySessionRoutes(ownerFor(sessionId), env, [{ kind: routeKind, address: { sessionId } }], signal);
  return session ? session.generation : undefined;
}

export async function currentOpenCodeGeneration(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const ledger = await open(env);
  try { return (await ledger.session(ownerFor(sessionId)))?.generation; } finally { await ledger.close(); }
}

export async function detachOpenCodeSession(sessionId: string, generation: string, env: NodeJS.ProcessEnv): Promise<void> {
  await detachDeliverySession(ownerFor(sessionId), generation, env);
}
export async function endOpenCodeSession(sessionId: string, generation: string, env: NodeJS.ProcessEnv): Promise<void> {
  await markDeliverySessionDeleted(ownerFor(sessionId), generation, env);
}
export async function cancelOpenCodeDeliveries(sessionId: string, generation: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const ledger = await open(env);
  try { return await ledger.cancel({ owner: ownerFor(sessionId), generation }); } finally { await ledger.close(); }
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
  const ledger = await open(env);
  try {
    for (const attempt of await ledger.handoffs(ownerFor(sessionId), { generation })) {
      if (signal.aborted) return;
      const { correlation } = attempt;
      if (attempt.routeKind === routeKind && correlation.token === attempt.token && correlation.messageId !== undefined
        && correlation.payloadHash !== undefined && observed.get(correlation.messageId) === correlation.payloadHash)
        await ledger.observePresentation({ token: attempt.token, owner: ownerFor(sessionId), generation, routeKind, payloadHash: correlation.payloadHash }, { requireCurrent: true });
    }
  } finally { await ledger.close(); }
}

export async function receiveOpenCodePending(sessionId: string, generation: string, transport: DeliveryTransport, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const owner = ownerFor(sessionId);
  const ledger = await open(env);
  const lifetime = retainDeliveryLedger(ledger);
  const observer = await ledger.observe(owner);
  try {
    while (!signal.aborted) {
      const baseline = observer.generation;
      for (const card of await ledger.pending(owner, { generation })) {
        if (signal.aborted) return;
        lifetime.track(await ledger.dispatchHandoff(owner, card.key, transport, { generation, timeoutMs: 5000, signal }));
      }
      if (!signal.aborted) await observer.hinted(baseline, 2000, signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { observer.close(); await lifetime.close(); }
}
