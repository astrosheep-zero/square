import { Square } from '@astrosheep/square';
import type { Activity, ActivityId, Participant, StreamRecord } from '@astrosheep/square';
import type { BridgeSettings } from './config.js';
import { Directory } from './directory.js';
import type { SlackInboundMessage, SlackPort } from './slack-port.js';
import { asActivityId, createStateStore, loadState, rememberMessage, type BridgeState, type StateStore } from './state.js';
import { slackText, squareBody } from './text.js';

export interface BridgeOptions {
  readonly settings: BridgeSettings;
  readonly port: SlackPort;
  /** A caller-owned identity-free resource; the configured bridge owner controls its names. */
  readonly square?: Square;
  readonly log?: (line: string) => void;
  readonly pollIntervalMs?: number;
}

const PAGE = 100;
const STOP_GRACE_MS = 2000;
const HANDLED_SUBTYPES = new Set(['thread_broadcast', 'file_share']);

/**
 * One configured Slack channel and one local square, mirrored in both
 * directions. Identities come from the directory; this class only pumps.
 */
export class Bridge {
  private readonly settings: BridgeSettings;
  private readonly port: SlackPort;
  private readonly square: Square;
  private readonly owned: boolean;
  private readonly log: (line: string) => void;
  private readonly pollIntervalMs: number;
  private readonly store: StateStore;
  private readonly state: BridgeState;
  private readonly directory: Directory;
  private readonly wake = createWake();
  private inbound: Promise<void> = Promise.resolve();
  private reading?: AsyncIterator<StreamRecord>;
  private outbound?: Promise<void>;
  private running = false;
  private closed = false;

  private constructor(options: BridgeOptions, square: Square, store: StateStore, directory: Directory, owned: boolean) {
    this.settings = options.settings;
    this.port = options.port;
    this.square = square;
    this.owned = owned;
    this.store = store;
    this.state = store.state;
    this.directory = directory;
    this.log = options.log ?? ((line) => process.stderr.write(`square-slack-bridge: ${line}\n`));
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /** Learn bot identities, load the cursor and open the square. */
  static async open(options: BridgeOptions): Promise<Bridge> {
    const loaded = await loadState(options.settings.state);
    const store = createStateStore(options.settings.state, loaded.state);
    const directory = await Directory.build({
      settings: options.settings, port: options.port, state: store.state, save: () => store.save(),
    });
    const square = options.square ?? await Square.at({ path: options.settings.square });
    if (loaded.fresh) {
      // A first start begins at the current end of the archive; old history is not replayed.
      store.state.cursor = (await square.history({ limit: 1, order: 'desc' })).activities[0]?.id ?? null;
      await store.save();
    }
    return new Bridge(options, square, store, directory, options.square === undefined);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.port.connect({
        appToken: this.settings.bridge.appToken,
        botToken: this.settings.bridge.botToken,
        onMessage: (message) => this.enqueue(message),
        onError: (error) => this.log(`slack: ${describe(error)}`),
      });
    }
    catch (error) {
      this.running = false;
      throw error;
    }
    this.watch();
    this.outbound = this.pump();
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.running = false;
    this.closed = true;
    this.wake.poke();
    await this.port.close().catch((error: unknown) => this.log(`slack: ${describe(error)}`));
    await Promise.race([this.inbound, pause(STOP_GRACE_MS)]);
    await this.reading?.return?.(undefined);
    await this.outbound?.catch(() => undefined);
    if (this.owned) await this.square.close();
  }

  /** One Slack message becomes one Square activity, or nothing. */
  async handleInbound(message: SlackInboundMessage): Promise<void> {
    const handled = this.handled(message);
    if (handled === undefined) return;
    const { userId, text } = handled;
    await this.directory.learn(text);
    const participant = await this.participantFor(await this.directory.participantFor(userId));
    const reply = message.threadTs === undefined ? undefined : asActivityId(this.state.tsToActivity[message.threadTs]);
    const landed = await participant.express(squareBody(text, this.directory), {
      force: true, ...(reply === undefined ? {} : { reply }),
    }).catch((error: unknown) => {
      this.log(`square express failed for ${message.ts}: ${describe(error)}`);
      return undefined;
    });
    if (landed === undefined) return;
    rememberMessage(this.state, landed.activity.id, message.ts, message.threadTs);
    await this.store.save();
  }

  /** Post every square activity after the cursor that Slack has not seen yet. */
  async drainOutbound(): Promise<void> {
    for (;;) {
      const activities = await this.nextActivities();
      if (activities.length === 0) return;
      for (const activity of activities) await this.mirror(activity);
      if (activities.length < PAGE) return;
    }
  }

  private enqueue(message: SlackInboundMessage): void {
    this.inbound = this.inbound
      .then(() => this.handleInbound(message))
      .catch((error: unknown) => this.log(`slack message ${message.ts}: ${describe(error)}`));
  }

  /** The message this bridge acts on, or nothing. */
  private handled(message: SlackInboundMessage): { userId: string; text: string } | undefined {
    if (message.channel !== this.settings.channel) return undefined;
    if (message.subtype !== undefined && !HANDLED_SUBTYPES.has(message.subtype)) return undefined;
    if (message.text === undefined || message.text.trim() === '') return undefined;
    if (message.userId === undefined) return undefined;
    if (this.directory.isOwnBot(message)) return undefined;
    return { userId: message.userId, text: message.text };
  }

  private async participantFor(name: string): Promise<Participant> {
    return (await this.square.join(name, { owner: this.settings.owner })).participant;
  }

  private async mirror(activity: Activity): Promise<void> {
    const body = activity.kind === 'say' ? activity.body : undefined;
    if (body !== undefined && body.trim() !== '' && !activity.actor.startsWith('slack/')) {
      const reply = activity.reply === undefined ? undefined : asActivityId(activity.reply);
      const threadTs = reply === undefined ? undefined : this.state.activityToTs[reply]?.threadTs;
      try {
        const posted = await this.port.postMessage({
          ...this.directory.posterFor(activity.actor),
          channel: this.settings.channel,
          text: slackText(body, this.directory),
          ...(threadTs === undefined ? {} : { threadTs }),
        });
        rememberMessage(this.state, activity.id, posted.ts, threadTs);
      }
      catch (error) {
        this.log(`slack post failed for ${activity.id}: ${describe(error)}`);
      }
    }
    this.state.cursor = activity.id;
    await this.store.save();
  }

  private async nextActivities(): Promise<readonly Activity[]> {
    const cursor = asActivityId(this.state.cursor);
    if (cursor !== undefined) return (await this.square.history({ after: cursor, limit: PAGE })).activities;
    // A bridge that first started on an empty square has no cursor yet. Read the whole
    // archive from its newest end, so nothing that landed while it was stopped is skipped.
    const pages: (readonly Activity[])[] = [];
    let before: ActivityId | undefined;
    for (;;) {
      const page = (await this.square.history(before === undefined ? { limit: PAGE } : { before, limit: PAGE })).activities;
      pages.push(page);
      if (page.length < PAGE) return pages.reverse().flat();
      before = page[0]!.id;
    }
  }

  private watch(): void {
    const reading = this.square.stream({ start: { kind: 'tail', last: 0 } })[Symbol.asyncIterator]();
    this.reading = reading;
    void (async () => {
      try {
        for (;;) {
          const next = await reading.next();
          if (next.done === true) return;
          this.wake.poke();
        }
      }
      catch (error) {
        if (this.running) this.log(`stream: ${describe(error)}; polling every ${this.pollIntervalMs}ms`);
      }
    })();
  }

  private async pump(): Promise<void> {
    while (this.running) {
      try {
        await this.drainOutbound();
      }
      catch (error) {
        this.log(`outbound: ${describe(error)}`);
      }
      if (this.running) await this.wake.wait(this.pollIntervalMs);
    }
  }
}

/** A one-shot signal that also falls back to a poll interval. */
function createWake(): { poke(): void; wait(ms: number): Promise<void> } {
  let poked = false;
  const waiters = new Set<() => void>();
  return {
    poke(): void {
      poked = true;
      for (const release of [...waiters]) release();
    },
    async wait(ms: number): Promise<void> {
      if (!poked) {
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout | undefined;
          const release = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            waiters.delete(release);
            resolve();
          };
          timer = setTimeout(release, ms);
          waiters.add(release);
        });
      }
      poked = false;
    },
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A failure message that keeps a Square error code or a Slack error code visible. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && !message.startsWith(code) ? `${code}: ${message}` : message;
}
