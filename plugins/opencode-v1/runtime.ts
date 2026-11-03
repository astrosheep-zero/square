import { canonicalPath } from '../../canonical-path.js';
import { observeSquareIndex } from '../../square-index.js';
import { discoverOpenCodeSeats, endOpenCodeSession, indexedOpenCodeSessions, observeOpenCodeContext, publishOpenCodeAddress, receiveOpenCodePending } from '../opencode-shared/delivery.js';
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
interface Receiver { abort: AbortController; running: Promise<void>; settled: boolean }

export async function startReceiver(ctx: Context) {
  const env = { ...process.env };
  const directory = await canonicalPath(ctx.directory);
  const index = await observeSquareIndex(env);
  const lifetime = new AbortController();
  const receivers = new Map<string, Receiver>();
  const terminal = new Set<string>();
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
    const candidates = new Set(await indexedOpenCodeSessions(env));
    if (active) candidates.add(active);
    for (const id of candidates) {
      if (lifetime.signal.aborted) return;
      if (terminal.has(id) || !await validate(id) || terminal.has(id)) { stop(id); continue; }
      if (!await publishOpenCodeAddress(id, env, lifetime.signal) || terminal.has(id)) { stop(id); continue; }
      if (receivers.get(id)?.settled === false) continue;
      const abort = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, abort.signal]);
      const receiver: Receiver = { abort, settled: false, running: receiveOpenCodePending(id, legacyTransport(ctx.client, id, signal), env, signal).catch(() => {}).finally(() => { receiver.settled = true; }) };
      receivers.set(id, receiver);
    }
    for (const id of receivers.keys()) if (!candidates.has(id)) stop(id);
  };
  const loop = (async () => {
    while (!lifetime.signal.aborted) {
      const baseline = await index.read(lifetime.signal);
      await coordinate(() => reconcile());
      await index.changed(baseline, Infinity, lifetime.signal);
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
      await observeOpenCodeContext(id, messages, env, AbortSignal.any([lifetime.signal, receiver.abort.signal])).catch(() => {});
    },
    event: async ({ event }: { event: { type: string; properties?: { info?: { id?: string; projectID?: string; directory?: string } } } }) => {
      const info = event.properties?.info;
      if (event.type !== 'session.deleted' || !info?.id || info.projectID !== ctx.project.id || typeof info.directory !== 'string'
        || await canonicalPath(info.directory).catch(() => undefined) !== directory) return;
      const id = info.id;
      terminal.add(id);
      stop(id);
      await coordinate(async () => {
        const seats = await discoverOpenCodeSeats(id, env, lifetime.signal);
        await endOpenCodeSession(id, env, lifetime.signal, seats);
      });
    },
    dispose: () => disposal ??= (async () => {
      lifetime.abort(); index.close();
      const tasks = [loop, coordinating, ...[...receivers.keys()].map(stop)];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled(tasks), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    })(),
  };
}
