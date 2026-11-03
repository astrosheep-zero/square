import { canonicalPath } from '../../canonical-path.js';
import { cancelOpenCodeDeliveries, currentOpenCodeGeneration, detachOpenCodeSession, endOpenCodeSession, listOpenCodeSessions, observeOpenCodeContext, observeOpenCodeSessions, publishOpenCodeAddress, receiveOpenCodePending } from '../opencode-shared/delivery.js';
import { legacyTransport } from './transport.js';

interface Context {
  readonly directory: string;
  readonly project: { readonly id: string };
  readonly client: { readonly session: {
    get(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    promptAsync(input: unknown): Promise<{ error?: unknown; response?: Response }>;
  } };
}
interface NativeMessage { info?: { id?: string; sessionID?: string; role?: string }; parts?: { type?: string; text?: string; sessionID?: string; messageID?: string; synthetic?: boolean; ignored?: boolean }[] }
interface Receiver { abort: AbortController; running: Promise<void>; generation: string; settled: boolean }

export async function startReceiver(ctx: Context) {
  const env = { ...process.env };
  const directory = await canonicalPath(ctx.directory);
  const discovery = await observeOpenCodeSessions(env);
  const lifetime = new AbortController();
  const receivers = new Map<string, Receiver>();
  const terminal = new Set<string>();
  const interrupting = new Set<string>();
  const cancellationFailed = new Set<string>();
  let coordinating = Promise.resolve();
  const coordinate = (operation: () => Promise<void>) => {
    coordinating = coordinating.then(() => lifetime.signal.aborted ? undefined : operation()).catch(() => {});
    return coordinating;
  };
  const stop = (id: string) => {
    const receiver = receivers.get(id);
    receiver?.abort.abort();
    receivers.delete(id);
    return receiver?.running;
  };
  const validate = async (id: string) => {
    const result = await ctx.client.session.get({ path: { id }, signal: lifetime.signal }).catch(() => undefined);
    const info = result?.data as { id?: string; projectID?: string; directory?: string } | undefined;
    return !result?.error && info?.id === id && info.projectID === ctx.project.id && typeof info.directory === 'string'
      && await canonicalPath(info.directory) === directory;
  };
  const reconcile = async (active?: string) => {
    const candidates = new Set(await listOpenCodeSessions(env));
    if (active) candidates.add(active);
    for (const id of candidates) {
      if (lifetime.signal.aborted) return;
      if (interrupting.has(id) || cancellationFailed.has(id)) continue;
      if (terminal.has(id) || !await validate(id) || terminal.has(id)) {
        const receiver = receivers.get(id);
        stop(id);
        if (receiver) await detachOpenCodeSession(id, receiver.generation, env);
        continue;
      }
      const existing = receivers.get(id);
      if (existing?.settled === false || interrupting.has(id)) continue;
      const generation = existing?.generation ?? await publishOpenCodeAddress(id, env, lifetime.signal);
      if (!generation) { stop(id); continue; }
      if (terminal.has(id) || interrupting.has(id) || lifetime.signal.aborted) { await detachOpenCodeSession(id, generation, env); continue; }
      const abort = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, abort.signal]);
      const receiver: Receiver = { abort, generation, settled: false, running: receiveOpenCodePending(id, generation, legacyTransport(ctx.client, id, signal), env, signal).catch(() => {}).finally(() => { receiver.settled = true; }) };
      receivers.set(id, receiver);
    }
    for (const id of receivers.keys()) if (!candidates.has(id)) stop(id);
  };
  const loop = (async () => {
    while (!lifetime.signal.aborted) {
      const baseline = discovery.observer.generation;
      await coordinate(() => reconcile());
      await discovery.observer.hinted(baseline, 2000, lifetime.signal);
    }
  })().catch(() => {});
  let disposal: Promise<void> | undefined;
  return {
    'experimental.chat.messages.transform': async (_input: unknown, output: { messages: NativeMessage[] }) => {
      const ids = new Set(output.messages.map(message => message.info?.sessionID));
      if (ids.size !== 1 || typeof [...ids][0] !== 'string') return;
      const id = [...ids][0]!;
      if (terminal.has(id)) return;
      await coordinate(() => reconcile(id));
      const receiver = receivers.get(id);
      if (!receiver || terminal.has(id) || lifetime.signal.aborted) return;
      const messages = output.messages.flatMap(({ info, parts }) => {
        if (info?.role !== 'user' || !info.id || !parts?.length || !parts.every(part => part.type === 'text'
          && typeof part.text === 'string' && part.sessionID === id && part.messageID === info.id && !part.synthetic && !part.ignored)) return [];
        return [{ id: info.id, role: 'user', content: parts.map(part => ({ type: 'text', text: part.text })) }];
      });
      await observeOpenCodeContext(id, receiver.generation, messages, env, AbortSignal.any([lifetime.signal, receiver.abort.signal])).catch(() => {});
    },
    event: async ({ event }: { event: { type: string; properties?: { sessionID?: string; error?: { name?: string }; info?: { id?: string; projectID?: string; directory?: string } } } }) => {
      const interrupted = event.type === 'session.error' && event.properties?.error?.name === 'MessageAbortedError'
        ? event.properties.sessionID : undefined;
      if (interrupted) {
        const receiver = receivers.get(interrupted);
        if (!receiver || interrupting.has(interrupted)) return;
        interrupting.add(interrupted);
        stop(interrupted);
        await coordinate(async () => {
          try {
            await receiver.running;
            if (!await cancelOpenCodeDeliveries(interrupted, receiver.generation, env)) throw new Error('OpenCode cancellation fence lost');
          } catch (error) {
            cancellationFailed.add(interrupted);
            await detachOpenCodeSession(interrupted, receiver.generation, env).catch(() => {});
            throw error;
          } finally { interrupting.delete(interrupted); }
          await reconcile(interrupted);
        });
        return;
      }
      const info = event.properties?.info;
      if (event.type !== 'session.deleted' || !info?.id || info.projectID !== ctx.project.id || typeof info.directory !== 'string'
        || await canonicalPath(info.directory).catch(() => undefined) !== directory) return;
      const id = info.id;
      terminal.add(id);
      const receiver = receivers.get(id);
      stop(id);
      await coordinate(async () => {
        const generation = receiver?.generation ?? await currentOpenCodeGeneration(id, env);
        if (generation) await endOpenCodeSession(id, generation, env);
      });
    },
    dispose: () => disposal ??= (async () => {
      lifetime.abort();
      const captured = [...receivers.entries()];
      const tasks = [loop, coordinating, ...captured.map(([id]) => stop(id))];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled(tasks), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      await Promise.allSettled(captured.map(([id, receiver]) => detachOpenCodeSession(id, receiver.generation, env)));
      await discovery.close();
    })(),
  };
}
