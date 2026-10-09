import { automaticSessionStart, operationEnv } from './automatic-session.js';
import { hostLedgerForEnv } from './registry.js';
import { canonicalPath } from './canonical-path.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { Square } from './square-wiring.js';
import { connectNative, type OpenCodeNativeSession, type OpenCodeSessionCapability } from './packages/agent-delivery/src/opencode-native.js';
import { observeOpenCodeContext, publishOpenCodeRoutes, receiveOpenCodePending, type OpenCodeContextMessage } from './opencode-delivery.js';

interface OpenCodePluginContext {
  readonly app: { readonly version: string };
  readonly location: { readonly directory: string; readonly project: { readonly id: string }; readonly workspaceID?: string };
  readonly session: OpenCodeSessionCapability & {
    hook(name: 'prompt', callback: (event: { sessionID: string }) => Promise<void>): Promise<unknown>;
    hook(name: 'context', callback: (event: { sessionID: string; messages: OpenCodeContextMessage[] }) => Promise<void>): Promise<unknown>;
  };
  readonly event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type: string; data: { sessionID?: string; reason?: string } }> };
}
interface Receiver { readonly abort: AbortController; readonly running: Promise<void> }

/** Actual OpenCode 2.0.20 server plugin. Harness identity belongs to ctx, never process.env. */
export default {
  id: 'square',
  async setup(ctx: OpenCodePluginContext): Promise<() => Promise<void>> {
    if (ctx.app.version !== '2.0.20') return async () => {};
    const env = { ...process.env };
    const ledger = hostLedgerForEnv(env);
    const lifetime = new AbortController();
    const receivers = new Map<string, Receiver>(); // Operational handles only; presence owns membership.
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
      const candidates = new Set((await ledger.listPresence({})).filter((binding) => binding.channel === 'opencode').map((binding) => binding.session));
      if (activeSession) candidates.add(activeSession);
      for (const sessionId of candidates) {
        if (lifetime.signal.aborted) return;
        const target = await validate(sessionId);
        if (!target) { stop(sessionId); continue; }
        const scopedEnv = operationEnv('opencode', sessionId, env);
        if (sessionId === activeSession) await automaticSessionStart('opencode', sessionId, directory, scopedEnv);
        if (!await publishOpenCodeRoutes(sessionId, scopedEnv, lifetime.signal)) { stop(sessionId); continue; }
        if (receivers.has(sessionId)) continue;
        const abort = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, abort.signal]);
        const running = receiveOpenCodePending(target, scopedEnv, signal).catch(() => {});
        receivers.set(sessionId, { abort, running });
      }
      for (const sessionId of receivers.keys()) if (!candidates.has(sessionId)) stop(sessionId);
    };
    const cancel = async (sessionId: string) => {
      if (!receivers.has(sessionId)) return;
      // Stop synchronously; persist the cutoff before allowing reconciliation to start fresh work.
      stop(sessionId);
      await ledger.withClaimLock(async () => {
        for (const owner of (await ledger.listPresence({ session: sessionId })).filter((binding) => binding.channel === 'opencode')) {
          const square = await openSquare(owner.location, { hostLedger: ledger, env, signal: lifetime.signal });
          try { await ledger.suppressPresence(owner, (await square.artifact.read(lifetime.signal)).state.runtime.nextActIndex - 1); }
          finally { await closeOpenSquare(square); }
        }
      }, lifetime.signal);
      await reconcile();
    };
    const end = async (sessionId: string) => {
      stop(sessionId);
      const memberships = (await ledger.listPresence({ session: sessionId })).filter((binding) => binding.channel === 'opencode');
      for (const owner of memberships) {
        const square = await Square.at({ path: owner.location, hostLedger: ledger, env: operationEnv('opencode', sessionId, env) });
        try { await square.endOwnedSession(owner.participant, sessionId, owner.epoch); }
        finally { await square.close(); }
      }
    };

    await ctx.session.hook('prompt', (event) => coordinate(() => reconcile(event.sessionID)));
    await ctx.session.hook('context', async (event) => {
      await coordinate(() => reconcile(event.sessionID));
      const receiver = receivers.get(event.sessionID);
      if (!receiver || lifetime.signal.aborted) return;
      await observeOpenCodeContext(event.sessionID, event.messages, operationEnv('opencode', event.sessionID, env),
        AbortSignal.any([lifetime.signal, receiver.abort.signal])).catch(() => {});
    });
    const changes = await ledger.observeChanges();
    changes.evidence.close(); // Manual joins activate an idle receiver; evidence already has a session observer.
    const presenceLoop = (async () => {
      while (!lifetime.signal.aborted) {
        const baseline = await changes.presence.read(lifetime.signal);
        await coordinate(() => reconcile());
        await changes.presence.changed(baseline, Infinity, lifetime.signal);
      }
    })().catch(() => {});
    const eventLoop = (async () => {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
        const sessionId = event.data.sessionID;
        if (!sessionId) continue;
        if (event.type === 'session.deleted') await coordinate(() => end(sessionId));
        else if (event.type === 'session.moved') await coordinate(async () => { stop(sessionId); await reconcile(); });
        else if (event.type === 'session.execution.interrupted' && event.data.reason === 'user') {
          receivers.get(sessionId)?.abort.abort();
          await coordinate(() => cancel(sessionId));
        }
      }
    })().catch(() => {});
    // Do not await any native prompt in setup: plugin activation itself is lazy.
    return async () => {
      lifetime.abort();
      changes.presence.close();
      const tasks = [presenceLoop, eventLoop, coordinating, ...[...receivers.keys()].map(stop)];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled(tasks), new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      // Instance unload is not session deletion: retain memberships and uncertain correlations.
    };
  },
};
