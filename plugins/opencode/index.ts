import { createHash } from 'node:crypto';
import { renderDeliveryReminder } from '../../delivery-frame.js';
import type { DeliveryTransport } from '../../delivery-ledger.js';
import { canonicalPath } from '../../canonical-path.js';
import { connectNative, createNativeInputId, sendNativeText, type OpenCodeNativeSession, type OpenCodeSessionCapability } from '../../packages/agent-delivery/src/opencode-native.js';
import { cancelOpenCodeDeliveries, currentOpenCodeGeneration, detachOpenCodeSession, endOpenCodeSession, listOpenCodeSessions, observeOpenCodeContext, observeOpenCodeSessions, publishOpenCodeAddress, receiveOpenCodePending, type OpenCodeContextMessage } from '../opencode-shared/delivery.js';

const routeKind = 'opencode-server' as const;

export function createOpenCodeWakeTransport(target: OpenCodeNativeSession, lifetime: AbortSignal): DeliveryTransport {
  return {
    kind: routeKind,
    async send(card, address, context) {
      const signal = AbortSignal.any([lifetime, context.signal]);
      if (address.sessionId !== target.sessionId || signal.aborted) return 'not-capable';
      const messageId = createNativeInputId();
      const text = renderDeliveryReminder([card.text], { tagged: true });
      const payloadHash = createHash('sha256').update(text).digest('hex');
      if (!await context.prepare({ token: context.token, messageId, payloadHash }) || signal.aborted
        || !await context.beforeSend() || signal.aborted || Date.now() >= context.deadline) return 'not-capable';
      const result = await sendNativeText(target, text, {
        inputId: messageId, delivery: 'steer', timeoutMs: Math.max(1, context.deadline - Date.now()), signal,
      });
      if (result.state === 'accepted') return 'accepted';
      if (result.state === 'unavailable') return 'failed';
      return 'unknown';
    },
  };
}

interface OpenCodePluginContext {
  readonly app: { readonly version: string };
  readonly location: { readonly directory: string; readonly project: { readonly id: string }; readonly workspaceID?: string };
  readonly session: OpenCodeSessionCapability & {
    hook(name: 'prompt', callback: (event: { sessionID: string }) => Promise<void>): Promise<unknown>;
    hook(name: 'context', callback: (event: { sessionID: string; messages: OpenCodeContextMessage[] }) => Promise<void>): Promise<unknown>;
  };
  readonly event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type: string; data: { sessionID?: string; reason?: string } }> };
}
interface Receiver { readonly abort: AbortController; readonly running: Promise<void>; readonly generation: string; settled: boolean }

/** OpenCode v2 server plugin. Harness identity belongs to ctx, never process.env. */
export default {
  id: 'square',
  async setup(ctx: OpenCodePluginContext): Promise<() => Promise<void>> {
    // OpenCode publishes semantic versions; unknown version forms are not evidence of a v2 host.
    const version = ctx?.app?.version;
    const reason = typeof version !== 'string' || !/^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
      ? 'expected an OpenCode 2.x semantic version'
      : typeof ctx.location?.directory !== 'string' || !ctx.location.directory ||
        typeof ctx.location.project?.id !== 'string' || !ctx.location.project.id ||
        (ctx.location.workspaceID !== undefined && typeof ctx.location.workspaceID !== 'string')
        ? 'missing location directory or project identity'
        : typeof ctx.session?.hook !== 'function' || typeof ctx.session.get !== 'function' || typeof ctx.session.prompt !== 'function'
          ? 'missing session hook, get, or prompt capability'
          : typeof ctx.event?.subscribe !== 'function' ? 'missing event subscription capability' : undefined;
    if (reason) {
      console.warn(`Square OpenCode plugin inactive: ${reason}.`);
      return async () => {};
    }
    const env = { ...process.env };
    const lifetime = new AbortController();
    const discovery = await observeOpenCodeSessions(env, lifetime.signal);
    const receivers = new Map<string, Receiver>(); // Operational handles only; presence owns membership.
    const interrupting = new Set<string>();
    const cancellationFailed = new Set<string>();
    const directory = await canonicalPath(ctx.location.directory);
    let coordinating = Promise.resolve();
    const coordinate = (operation: () => Promise<void>) => {
      const task = coordinating.then(() => lifetime.signal.aborted ? undefined : operation());
      coordinating = task.catch(() => {}); // Optional Square hooks must never fail primary request preparation.
      return coordinating;
    };
    const stop = (sessionId: string) => {
      const receiver = receivers.get(sessionId);
      receiver?.abort.abort();
      receivers.delete(sessionId);
      return receiver?.running;
    };
    const validate = async (sessionId: string): Promise<OpenCodeNativeSession | undefined> => {
      let info: unknown;
      const target = await connectNative({ sessionId, timeoutMs: 3000, signal: lifetime.signal, session: {
        async get(input) { info = await ctx.session.get(input); return info; },
        prompt: (input) => ctx.session.prompt(input),
      } }).catch(() => undefined);
      const record = info as { projectID?: string; location?: { directory?: string; workspaceID?: string } } | undefined;
      if (!target || !record?.location?.directory || record.projectID !== ctx.location.project.id
        || record.location.workspaceID !== ctx.location.workspaceID
        || await canonicalPath(record.location.directory) !== directory) return undefined;
      return target;
    };
    const reconcile = async (activeSession?: string) => {
      const candidates = new Set(await listOpenCodeSessions(env, lifetime.signal));
      if (activeSession) candidates.add(activeSession);
      for (const sessionId of candidates) {
        if (lifetime.signal.aborted) return;
        if (interrupting.has(sessionId) || cancellationFailed.has(sessionId)) continue;
        const target = await validate(sessionId);
        if (!target) {
          const receiver = receivers.get(sessionId);
          stop(sessionId);
          if (receiver) await detachOpenCodeSession(sessionId, receiver.generation, env, lifetime.signal);
          continue;
        }
        const existing = receivers.get(sessionId);
        if (existing?.settled === false || interrupting.has(sessionId)) continue;
        const generation = existing?.generation ?? await publishOpenCodeAddress(sessionId, env, lifetime.signal);
        if (!generation) { stop(sessionId); continue; }
        if (lifetime.signal.aborted || interrupting.has(sessionId)) { await detachOpenCodeSession(sessionId, generation, env); continue; }
        const abort = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, abort.signal]);
        const receiver: Receiver = { abort, generation, settled: false, running: receiveOpenCodePending(sessionId, generation, createOpenCodeWakeTransport(target, signal), env, signal).catch(() => {}).finally(() => { receiver.settled = true; }) };
        receivers.set(sessionId, receiver);
      }
      for (const sessionId of receivers.keys()) if (!candidates.has(sessionId)) stop(sessionId);
    };
    const cancel = async (sessionId: string) => {
      const receiver = receivers.get(sessionId);
      if (!receiver) return;
      stop(sessionId);
      await receiver.running;
      try {
        if (!await cancelOpenCodeDeliveries(sessionId, receiver.generation, env)) throw new Error('OpenCode cancellation fence lost');
      } catch (error) {
        cancellationFailed.add(sessionId);
        await detachOpenCodeSession(sessionId, receiver.generation, env).catch(() => {});
        throw error;
      } finally { interrupting.delete(sessionId); }
      await reconcile(sessionId);
    };
    const end = async (sessionId: string) => {
      const receiver = receivers.get(sessionId);
      stop(sessionId);
      const generation = receiver?.generation ?? await currentOpenCodeGeneration(sessionId, env);
      if (generation) await endOpenCodeSession(sessionId, generation, env);
    };

    await ctx.session.hook('prompt', (event) => coordinate(() => reconcile(event.sessionID)));
    await ctx.session.hook('context', async (event) => {
      await coordinate(() => reconcile(event.sessionID));
      const receiver = receivers.get(event.sessionID);
      if (!receiver || lifetime.signal.aborted) return;
      await observeOpenCodeContext(event.sessionID, receiver.generation, event.messages, env,
        AbortSignal.any([lifetime.signal, receiver.abort.signal])).catch(() => {});
    });
    const presenceLoop = (async () => {
      while (!lifetime.signal.aborted) {
        const baseline = discovery.observer.generation;
        await coordinate(() => reconcile());
        await discovery.observer.hinted(baseline, 2000, lifetime.signal);
      }
    })().catch(() => {});
    const eventLoop = (async () => {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
        const sessionId = event.data.sessionID;
        if (!sessionId) continue;
        if (event.type === 'session.deleted') await coordinate(() => end(sessionId));
        else if (event.type === 'session.moved') await coordinate(async () => {
          const receiver = receivers.get(sessionId);
          stop(sessionId);
          if (receiver) await detachOpenCodeSession(sessionId, receiver.generation, env, lifetime.signal);
          await reconcile();
        });
        else if (event.type === 'session.execution.interrupted' && event.data.reason === 'user') {
          if (interrupting.has(sessionId) || !receivers.has(sessionId)) continue;
          interrupting.add(sessionId);
          receivers.get(sessionId)?.abort.abort();
          await coordinate(() => cancel(sessionId));
        }
      }
    })().catch(() => {});
    // Do not await any native prompt in setup: plugin activation itself is lazy.
    return async () => {
      lifetime.abort();
      const captured = [...receivers.entries()];
      const tasks = [presenceLoop, eventLoop, coordinating, ...captured.map(([id]) => stop(id))];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled(tasks), new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      await Promise.allSettled(captured.map(([id, receiver]) => detachOpenCodeSession(id, receiver.generation, env)));
      await discovery.close();
      // Instance unload is not session deletion: retain memberships and uncertain correlations.
    };
  },
};
