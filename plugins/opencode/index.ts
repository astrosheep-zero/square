import { canonicalPath } from '../../canonical-path.js';
import { connectNative, createNativeInputId, sendNativeText, type OpenCodeNativeSession, type OpenCodeSessionCapability } from '../../packages/agent-delivery/src/opencode-native.js';
import { openCodeTransport, startOpenCodeReceivers, type OpenCodeContextMessage } from '../opencode-shared/delivery.js';

export function createOpenCodeWakeTransport(target: OpenCodeNativeSession, lifetime: AbortSignal) {
  return openCodeTransport(target.sessionId, lifetime, createNativeInputId, async ({ messageId, text, signal, deadline }) => {
    const result = await sendNativeText(target, text, {
      inputId: messageId, delivery: 'steer', timeoutMs: Math.max(1, deadline - Date.now()), signal,
    });
    if (result.state === 'accepted') return 'accepted';
    return result.state === 'unavailable' ? 'failed' : 'unknown';
  });
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
    const directory = await canonicalPath(ctx.location.directory);
    const receivers = await startOpenCodeReceivers(env, async (sessionId, lifetime) => {
      let info: unknown;
      const target = await connectNative({ sessionId, timeoutMs: 3000, signal: lifetime, session: {
        async get(input) { info = await ctx.session.get(input); return info; },
        prompt: (input) => ctx.session.prompt(input),
      } }).catch(() => undefined);
      const record = info as { projectID?: string; location?: { directory?: string; workspaceID?: string } } | undefined;
      if (!target || !record?.location?.directory || record.projectID !== ctx.location.project.id
        || record.location.workspaceID !== ctx.location.workspaceID
        || await canonicalPath(record.location.directory) !== directory) return undefined;
      return (signal: AbortSignal) => createOpenCodeWakeTransport(target, signal);
    });
    let eventLoop: Promise<void> | undefined;
    try {
      await ctx.session.hook('prompt', event => receivers.refresh(event.sessionID));
      await ctx.session.hook('context', event => receivers.context(event.sessionID, () => event.messages));
      const subscription = ctx.event.subscribe({ signal: receivers.signal });
      eventLoop = (async () => {
        try {
          for await (const event of subscription) {
            const sessionId = event.data.sessionID;
            if (!sessionId) continue;
            if (event.type === 'session.deleted') await receivers.deleted(sessionId, 'coordinated');
            else if (event.type === 'session.moved') await receivers.moved(sessionId);
            else if (event.type === 'session.execution.interrupted' && event.data.reason === 'user') await receivers.interrupt(sessionId, 'coordinated');
          }
        } catch { void receivers.dispose().catch(() => {}); } // Losing the stream fails closed; this loop must finish independently.
      })();
      receivers.start();
    } catch (error) {
      await receivers.dispose(eventLoop).catch(() => {});
      throw error;
    }
    // Do not await any native prompt in setup: plugin activation itself is lazy.
    return () => receivers.dispose(eventLoop);
  },
};
