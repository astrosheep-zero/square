import type { BridgeSettings } from './config.js';
import { slackName } from './names.js';
import type { SlackAuth, SlackInboundMessage, SlackPort, SlackPoster } from './slack-port.js';
import type { BridgeState } from './state.js';

export class DirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryError';
  }
}

export interface DirectoryOptions {
  readonly settings: BridgeSettings;
  readonly port: SlackPort;
  readonly state: BridgeState;
  /** Persist a newly assigned Slack name. */
  readonly save: () => Promise<void>;
}

const SLACK_PREFIX = 'slack/';
const USER_MENTION = /<@([A-Z0-9]+)(?:\|[^<>]*)?>/g;

interface Persona {
  readonly token: string;
  readonly auth: SlackAuth;
}

/**
 * The bridge's one identity map: which Slack user a Square name belongs to,
 * which Square name a Slack user becomes, and which token speaks for an actor.
 * Persona-native and fallback posting are the same answer here, so no other
 * module branches on them.
 */
export class Directory {
  private readonly personas = new Map<string, Persona>();
  private readonly personaByUserId = new Map<string, string>();
  private readonly botIds = new Set<string>();
  private readonly displays = new Map<string, string>();
  private readonly bridgeAuth: SlackAuth;

  private constructor(
    private readonly settings: BridgeSettings,
    private readonly port: SlackPort,
    private readonly state: BridgeState,
    private readonly save: () => Promise<void>,
    bridgeAuth: SlackAuth,
  ) {
    this.bridgeAuth = bridgeAuth;
    if (bridgeAuth.botId !== undefined) this.botIds.add(bridgeAuth.botId);
  }

  /** Learn every bot identity from `auth.test`; a failure names the bot, never the token. */
  static async build(options: DirectoryOptions): Promise<Directory> {
    const bridge = await authenticate(options.port, options.settings.bridge.botToken, 'the bridge bot');
    const directory = new Directory(options.settings, options.port, options.state, options.save, bridge);
    for (const [name, token] of options.settings.personas) {
      const persona = { token, auth: await authenticate(options.port, token, `persona ${name}`) };
      directory.personas.set(name, persona);
      directory.personaByUserId.set(persona.auth.userId, name);
      if (persona.auth.botId !== undefined) directory.botIds.add(persona.auth.botId);
    }
    return directory;
  }

  /** The token that speaks for an actor in Slack, with a display name only when it must stand in. */
  posterFor(actor: string): SlackPoster {
    const persona = this.personas.get(actor);
    return persona === undefined
      ? { token: this.settings.bridge.botToken, username: actor }
      : { token: persona.token };
  }

  /** The Square name a Slack user is addressed by, when the bridge can name them. */
  squareNameForSlackUser(userId: string): string | undefined {
    const persona = this.personaByUserId.get(userId);
    if (persona !== undefined) return persona;
    const assigned = this.state.users[userId];
    if (assigned !== undefined) return `${SLACK_PREFIX}${assigned}`;
    const display = this.displays.get(userId);
    return display === undefined ? undefined : slackName(display, userId);
  }

  /** The Slack user ID a Square participant can be mentioned as. */
  slackUserForSquareName(name: string): string | undefined {
    const persona = this.personas.get(name);
    if (persona !== undefined) return persona.auth.userId;
    if (!name.startsWith(SLACK_PREFIX)) return undefined;
    const segment = name.slice(SLACK_PREFIX.length).toLocaleLowerCase();
    for (const [userId, assigned] of Object.entries(this.state.users)) if (assigned.toLocaleLowerCase() === segment) return userId;
    return undefined;
  }

  /** The bridge's own bots must never be mirrored back into the square. */
  isOwnBot(message: SlackInboundMessage): boolean {
    if (message.userId !== undefined && (message.userId === this.bridgeAuth.userId || this.personaByUserId.has(message.userId))) return true;
    return message.botId !== undefined && this.botIds.has(message.botId);
  }

  /** Resolve every `<@U…>` in a message so text conversion can name it. */
  async learn(text: string): Promise<void> {
    for (const match of text.matchAll(USER_MENTION)) await this.identify(match[1]!);
  }

  /** The Square participant that speaks for a Slack human, assigning a stable name once. */
  async participantFor(userId: string): Promise<string> {
    const assigned = this.state.users[userId];
    if (assigned !== undefined) return `${SLACK_PREFIX}${assigned}`;
    await this.identify(userId);
    const name = this.unique(slackName(this.displays.get(userId) ?? userId, userId), userId);
    this.state.users[userId] = name;
    await this.save();
    return `${SLACK_PREFIX}${name}`;
  }

  private async identify(userId: string): Promise<void> {
    if (this.squareNameForSlackUser(userId) !== undefined) return;
    const user = await this.port.userInfo(this.settings.bridge.botToken, userId).catch(() => undefined);
    this.displays.set(userId, user?.displayName ?? user?.realName ?? userId);
  }

  private unique(candidate: string, userId: string): string {
    const taken = (name: string): boolean => Object.entries(this.state.users)
      .some(([other, assigned]) => other !== userId && assigned.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!taken(candidate)) return candidate;
    const suffixed = `${candidate}-${userId.slice(-4)}`;
    return taken(suffixed) ? `${candidate}-${userId}` : suffixed;
  }
}

async function authenticate(port: SlackPort, token: string, who: string): Promise<SlackAuth> {
  try {
    return await port.authTest(token);
  }
  catch (error) {
    throw new DirectoryError(`auth.test failed for ${who}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
