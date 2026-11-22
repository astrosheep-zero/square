import { canonicalPath } from '../../storage/canonical-path.js';
import { startOpenCodeReceivers } from '../opencode-shared/delivery.js';
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

export async function startReceiver(ctx: Context) {
  const env = { ...process.env };
  const directory = await canonicalPath(ctx.directory);
  const receivers = await startOpenCodeReceivers(env, async (id, lifetime) => {
    const result = await ctx.client.session.get({ path: { id }, signal: lifetime }).catch(() => undefined);
    const info = result?.data as { id?: string; projectID?: string; directory?: string } | undefined;
    return !result?.error && info?.id === id && info.projectID === ctx.project.id && typeof info.directory === 'string'
      && await canonicalPath(info.directory) === directory
      ? (signal: AbortSignal) => legacyTransport(ctx.client, id, signal) : undefined;
  });
  const hooks = {
    'experimental.chat.messages.transform': async (_input: unknown, output: { messages: NativeMessage[] }) => {
      const ids = new Set(output.messages.map(message => message.info?.sessionID));
      if (ids.size !== 1 || typeof [...ids][0] !== 'string') return;
      const id = [...ids][0]!;
      await receivers.context(id, () => output.messages.flatMap(({ info, parts }) => {
        if (info?.role !== 'user' || !info.id || !parts?.length || !parts.every(part => part.type === 'text'
          && typeof part.text === 'string' && part.sessionID === id && part.messageID === info.id && !part.synthetic && !part.ignored)) return [];
        return [{ id: info.id, role: 'user', content: parts.map(part => ({ type: 'text', text: part.text })) }];
      }));
    },
    event: async ({ event }: { event: { type: string; properties?: { sessionID?: string; error?: { name?: string }; info?: { id?: string; projectID?: string; directory?: string } } } }) => {
      const interrupted = event.type === 'session.error' && event.properties?.error?.name === 'MessageAbortedError'
        ? event.properties.sessionID : undefined;
      if (interrupted) { await receivers.interrupt(interrupted, 'immediate'); return; }
      const info = event.properties?.info;
      if (event.type !== 'session.deleted' || !info?.id || info.projectID !== ctx.project.id || typeof info.directory !== 'string'
        || await canonicalPath(info.directory).catch(() => undefined) !== directory) return;
      await receivers.deleted(info.id, 'immediate');
    },
    dispose: () => receivers.dispose(),
  };
  receivers.start();
  return hooks;
}
