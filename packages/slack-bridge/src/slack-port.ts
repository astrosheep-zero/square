/** A Slack `message` event in the configured channel. */
export interface SlackInboundMessage {
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly text?: string;
  readonly subtype?: string;
  readonly userId?: string;
  readonly botId?: string;
}

export interface SlackAuth {
  readonly userId: string;
  readonly botId?: string;
}

export interface SlackUser {
  readonly userId: string;
  readonly displayName?: string;
  readonly realName?: string;
}

export interface SlackPoster {
  readonly token: string;
  /** Slack-side display name; omitted when the token already belongs to that participant. */
  readonly username?: string;
}

export interface SlackPostRequest extends SlackPoster {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
}

export interface SlackConnection {
  readonly appToken: string;
  readonly botToken: string;
  readonly onMessage: (message: SlackInboundMessage) => void;
  readonly onError: (error: Error) => void;
}

/**
 * The narrow Slack surface the bridge needs. One real implementation wraps the
 * Slack SDKs; tests provide a fake.
 */
export interface SlackPort {
  connect(connection: SlackConnection): Promise<void>;
  close(): Promise<void>;
  authTest(token: string): Promise<SlackAuth>;
  userInfo(token: string, userId: string): Promise<SlackUser>;
  postMessage(request: SlackPostRequest): Promise<{ readonly ts: string }>;
}
