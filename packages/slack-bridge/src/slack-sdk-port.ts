import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { SlackAuth, SlackConnection, SlackInboundMessage, SlackPort, SlackPostRequest, SlackUser } from './slack-port.js';

interface SocketMessage {
  readonly ack: () => Promise<void>;
  readonly event: Record<string, unknown>;
}

/** The real Slack transport: Socket Mode in, Web API out. */
export function createSlackSdkPort(): SlackPort {
  const clients = new Map<string, WebClient>();
  let socket: SocketModeClient | undefined;
  const client = (token: string): WebClient => {
    let existing = clients.get(token);
    if (existing === undefined) {
      existing = new WebClient(token);
      clients.set(token, existing);
    }
    return existing;
  };
  return {
    async connect({ appToken, onMessage, onError }: SlackConnection): Promise<void> {
      const connected = new SocketModeClient({ appToken });
      connected.on('message', (payload: unknown) => {
        const message = payload as SocketMessage;
        void message.ack().catch((error: unknown) => onError(asError(error)));
        const event = inbound(message.event);
        if (event !== undefined) onMessage(event);
      });
      connected.on('error', (error: unknown) => onError(asError(error)));
      await connected.start();
      socket = connected;
    },
    async close(): Promise<void> {
      const connected = socket;
      socket = undefined;
      await connected?.disconnect();
    },
    async authTest(token: string): Promise<SlackAuth> {
      const response = await client(token).auth.test();
      if (response.user_id === undefined) throw new Error('auth.test returned no user id');
      return { userId: response.user_id, ...(response.bot_id === undefined ? {} : { botId: response.bot_id }) };
    },
    async userInfo(token: string, userId: string): Promise<SlackUser> {
      const response = await client(token).users.info({ user: userId });
      const user = response.user;
      const displayName = user?.profile?.display_name || undefined;
      const realName = user?.real_name || user?.profile?.real_name || undefined;
      return { userId, ...(displayName === undefined ? {} : { displayName }), ...(realName === undefined ? {} : { realName }) };
    },
    async postMessage({ token, channel, text, threadTs, username }: SlackPostRequest): Promise<{ ts: string }> {
      const response = await client(token).chat.postMessage({
        channel, text, mrkdwn: true,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        ...(username === undefined ? {} : { username }),
      });
      if (response.ts === undefined) throw new Error('chat.postMessage returned no message timestamp');
      return { ts: response.ts };
    },
  };
}

function inbound(event: Record<string, unknown>): SlackInboundMessage | undefined {
  if (typeof event.channel !== 'string' || typeof event.ts !== 'string') return undefined;
  return {
    channel: event.channel,
    ts: event.ts,
    ...(typeof event.thread_ts === 'string' ? { threadTs: event.thread_ts } : {}),
    ...(typeof event.text === 'string' ? { text: event.text } : {}),
    ...(typeof event.subtype === 'string' ? { subtype: event.subtype } : {}),
    ...(typeof event.user === 'string' ? { userId: event.user } : {}),
    ...(typeof event.bot_id === 'string' ? { botId: event.bot_id } : {}),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
