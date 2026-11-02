import crypto from 'node:crypto';

import { openChannelArtifact, createChannelArtifactFile, createMemoryChannelArtifact, channelCourier } from './channel-artifact.js';
import { canonicalPath } from './canonical-path.js';
import { codexWakeAddress } from './codex-address.js';
import { validateDeferralDuration, validateDeferralId, validateMetadataMatch, type MetadataMatch } from './delivery-deferral.js';
import { compileSearchPattern } from './search.js';
import { InternalSquareError, SquareError, type Owner } from './neutral.js';
import { messageMetadataHasContent, sameName, validateMessageMetadata, validateName, type WakeAddress } from './channel-values.js';
import { consumeReceived } from './receive.js';
import { harnessOwner } from './owner.js';
import { harnessSessionSources, type HarnessSessionChannel } from './participant-identity.js';
import type { ChannelWriteAuthority, ChannelArtifact, ChannelRead, ChannelWrite, EndpointFact, EndpointRef, MessageDraft, MessageFact, MessageFilter } from './channel-ports.js';
import type { WakeTransportPort } from './channel-transport.js';
import { formatMessageId, newEndpointGeneration, parseMessageId, validateEndpointGeneration, type MessageId } from './message.js';
import { rememberSquarePath, squareIndexPath } from './square-index.js';
import { squareLocation } from './square-location.js';
import type { AckResult, ChannelEndpointSummary, ChannelMessage, ChannelReceiveResult, ChannelPendingResult, ChannelHistoryResult,
  ChannelSendInput, ChannelSendResult, ChannelHistoryQuery, ChannelPendingOptions, ChannelEndpointHold } from './channel-facade.js';
import type { DeliveryDeferral } from './delivery-deferral.js';
import type { OperationControl, OperationFailureDetail } from './neutral.js';

export { harnessOwner, decodeHarnessOwner, localUserOwner } from './owner.js';
export type { MessageMetadata } from './channel-values.js';
export type { MessageSearch, ChannelTruncate, ChannelPendingOptions, MessageCursor, MessageQuery, ChannelPendingResult, ChannelHistoryResult, ChannelHistoryQuery, AckResult,
  ChannelEndpointSummary, ChannelMessage, ChannelReceiveResult } from './channel-facade.js';
export type { MessageId } from './message.js';
export type { ChannelArtifact } from './channel-ports.js';
export type { ChannelSendInput, ChannelSendResult, DeliveryDeferral, MetadataMatch,
  OperationControl, Owner, WakeAddress, WakeTransportPort, HarnessSessionChannel };

export interface ResolvedHarnessSession {
  readonly channel: HarnessSessionChannel;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly owner: Owner;
  readonly wakeAddress?: WakeAddress;
}

export function resolveHarnessSession(env: NodeJS.ProcessEnv = process.env): ResolvedHarnessSession | undefined {
  for (const { variable, channel } of harnessSessionSources) {
    const sessionId = env[variable]?.trim();
    if (!sessionId) continue;
    const agentId = channel === 'claude-code' && env.CLAUDE_CODE_CHILD_SESSION?.trim() === '1'
      ? env.CLAUDE_CODE_AGENT_ID?.trim() || undefined : undefined;
    const wakeAddress = channel === 'codex' ? codexWakeAddress(sessionId, env)
      : channel === 'paseo' ? { kind: 'paseo' as const, address: { agentId: sessionId } } : undefined;
    return { channel, sessionId, ...(agentId === undefined ? {} : { agentId }),
      owner: harnessOwner({ channel, session: sessionId, ...(agentId === undefined ? {} : { agent: agentId }) }),
      ...(wakeAddress === undefined ? {} : { wakeAddress }) };
  }
  return undefined;
}

export interface ChannelOpenInput {
  readonly path: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => number;
  /** Transport for post-commit custody; `false` disables delivery for this handle. */
  readonly wakeTransport?: WakeTransportPort | false;
}
export interface ChannelCreateInput extends ChannelOpenInput {
  readonly force?: boolean;
  readonly description?: string;
}
/** Every dependency one Channel needs; the artifact is already opened and narrowed. */
export interface ChannelPortInit {
  readonly location: string;
  readonly artifact: ChannelArtifact;
  readonly clock: () => number;
  readonly deliverEffect?: (message?: number) => Promise<void>;
  readonly indexPath?: string;
  readonly closesArtifact?: boolean;
}
type EndpointOptions = { readonly owner: Owner; readonly wakeAddress?: WakeAddress };

export function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted)
    throw control.signal.reason ?? new Error('Square operation was cancelled');
}
export function squareClock(env: NodeJS.ProcessEnv, clock?: () => number): () => number {
  if (clock !== undefined) return clock;
  if (env.SQUARE_NOW_MS === undefined) return Date.now;
  const value = Number.parseInt(env.SQUARE_NOW_MS, 10);
  if (!Number.isFinite(value)) throw new SquareError('invalid_args', 'Invalid SQUARE_NOW_MS: expected integer milliseconds.');
  return () => value;
}
export function failure(error: unknown, detail: OperationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}

function explicitLocation(input: ChannelOpenInput): string {
  if (typeof input?.path !== 'string' || input.path.trim() === '')
    throw new SquareError('invalid_args', 'Channel path is required.');
  return squareLocation(input);
}
function requireOwner(owner: Owner): Owner {
  if (typeof owner !== 'string' || !owner || Buffer.byteLength(owner, 'utf8') > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(owner))
    throw new SquareError('invalid_args', 'A participant write requires a non-empty owner without control characters (at most 512 UTF-8 bytes).');
  return owner;
}
/** A generic managed address must not displace the receiver's native registration on reconnect. */
function canRefreshWakeAddress(current: WakeAddress | undefined, proposed: WakeAddress): boolean {
  return proposed.kind !== 'paseo' || current === undefined || current.kind === 'paseo';
}

/** Foundational point-to-point endpoint and messaging resource over one artifact port. */
export class Channel {
  private constructor(
    readonly location: string,
    readonly artifact: ChannelArtifact,
    readonly clock: () => number,
    private readonly deliverEffect?: (message?: number) => Promise<void>,
    private readonly indexPath?: string,
    private readonly closesArtifact = true,
  ) { }

  /** Internal composition point for upper resources; no wrapping square is involved. */
  static fromPort(init: ChannelPortInit): Channel {
    return new Channel(init.location, init.artifact, init.clock, init.deliverEffect,
      init.indexPath, init.closesArtifact ?? true);
  }
  static async open(input: ChannelOpenInput, control?: OperationControl): Promise<Channel> {
    const path = explicitLocation(input);
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env, path });
    const clock = squareClock(env, input.clock);
    const artifact = openChannelArtifact(location, control?.signal);
    const transport = input.wakeTransport !== undefined
      ? input.wakeTransport || undefined
      : await import('./wake-transports.js').then(({ createDefaultWakeTransport }) => createDefaultWakeTransport(env)).catch(() => undefined);
    try {
      await artifact.read(facts => facts.header(), control?.signal);
      const deliveryLocation = await canonicalPath(location);
      return Channel.fromPort({ location, artifact, clock,
        ...(transport === undefined ? {} : { deliverEffect: channelCourier(artifact, transport, deliveryLocation, clock) }),
        indexPath: squareIndexPath(env) });
    } catch (error) {
      await artifact.close();
      if (error instanceof InternalSquareError && error.code === 'not_found')
        throw new SquareError('unavailable', `Channel is unavailable at ${location}`);
      throw error;
    }
  }
  static async create(input: ChannelCreateInput, control?: OperationControl): Promise<Channel> {
    const path = explicitLocation(input);
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env, path });
    // Endpoints and messages carry no Agora chatroom warmup.
    await createChannelArtifactFile(location, input.description ?? '# Channel\n', input.force ?? false, control?.signal);
    return Channel.open({ ...input, path: location, env }, control);
  }
  static inMemory(input: Omit<ChannelCreateInput, 'path' | 'force'> = {}): Channel {
    const env = { ...(input.env ?? process.env) };
    const artifact = createMemoryChannelArtifact(input.description ?? '# Channel\n');
    const location = `memory://${crypto.randomUUID()}`, clock = squareClock(env, input.clock);
    const transport = input.wakeTransport || undefined;
    return Channel.fromPort({ location, artifact, clock,
      ...(transport === undefined ? {} : { deliverEffect: channelCourier(artifact, transport, location, clock) }) });
  }

  async remember(owner: Owner): Promise<void> {
    if (this.indexPath !== undefined)
      await rememberSquarePath(this.location, owner, this.indexPath).catch(() => undefined);
  }

  /** Establish a new opaque endpoint generation, or take over the existing one explicitly. */
  async attach(name: string, options: EndpointOptions & { readonly takeover?: boolean }, control?: OperationControl): Promise<ChannelEndpoint> {
    checkControl(control);
    validateName(name);
    const owner = requireOwner(options?.owner);
    const endpoint = (await this.artifact.transactAs({ kind: 'endpoint', participant: name, owner }, (facts: ChannelWrite) => {
      const current = facts.endpoint(name);
      if (current !== undefined && !options.takeover) {
        if (current.owner !== owner) throw new SquareError('already_joined', `${name} is held by another owner; take it over explicitly.`);
        if (current.attachment === 'detached') facts.reattachEndpoint(current, options.wakeAddress);
        else if (options.wakeAddress !== undefined && canRefreshWakeAddress(current.wakeAddress, options.wakeAddress))
          facts.updateWakeAddress(current, options.wakeAddress);
        return facts.endpoint(name)!;
      }
      const endpoint: EndpointFact = { participant: name, owner, generation: newEndpointGeneration(), attachment: 'attached',
        ...(options.wakeAddress === undefined ? {} : { wakeAddress: options.wakeAddress }) };
      facts.storeEndpoint(endpoint);
      return endpoint;
    }, control?.signal)).value;
    await this.remember(owner);
    return new ChannelEndpoint(this, endpoint);
  }
  /** Restore an exact standing endpoint without changing its generation. */
  async reattach(name: string, { owner, wakeAddress }: Pick<EndpointOptions, 'owner' | 'wakeAddress'>, control?: OperationControl): Promise<ChannelEndpoint | null> {
    checkControl(control);
    validateName(name);
    requireOwner(owner);
    const current = (await this.artifact.read(facts => facts.endpoint(name), control?.signal)).value;
    if (current === undefined || current.owner !== owner) return null;
    return this.reattachEndpoint(current, wakeAddress, control);
  }
  private async reattachEndpoint(current: EndpointFact, wakeAddress: WakeAddress | undefined, control?: OperationControl): Promise<ChannelEndpoint> {
    const endpoint = (await this.artifact.transactAs({ kind: 'endpoint', participant: current.participant, owner: current.owner }, (facts: ChannelWrite) => {
      if (current.attachment === 'detached') facts.reattachEndpoint(current, wakeAddress);
      else if (wakeAddress !== undefined && canRefreshWakeAddress(current.wakeAddress, wakeAddress))
        facts.updateWakeAddress(current, wakeAddress);
      return facts.endpoint(current.participant)!;
    }, control?.signal)).value;
    return new ChannelEndpoint(this, endpoint);
  }
  /** Select one attached endpoint held by an exact owner. */
  async endpoint(name: string, { owner }: { readonly owner: Owner }): Promise<ChannelEndpoint> {
    validateName(name);
    requireOwner(owner);
    const endpoint = (await this.artifact.read(facts => {
      const current = facts.endpoint(name);
      if (current === undefined || current.owner !== owner || current.attachment !== 'attached') {
        throw new SquareError('already_joined', current === undefined
          ? `${name} has no endpoint in this channel.`
          : current.owner !== owner ? `${name} is not held by this owner.` : `${name} is away.`, { reason: 'needs_seat' });
      }
      return current;
    })).value;
    return new ChannelEndpoint(this, endpoint);
  }
  async endpointsOf(owner: Owner): Promise<readonly ChannelEndpointHold[]> {
    requireOwner(owner);
    return (await this.artifact.read(facts => facts.endpointsForOwner(owner).map(({ participant, generation, attachment }) =>
      ({ name: participant, generation, attachment })))).value;
  }
  async listEndpoints(control?: OperationControl): Promise<readonly ChannelEndpointSummary[]> {
    checkControl(control);
    return (await this.artifact.read(facts => facts.endpoints()
      .map(endpoint => ({
        name: endpoint.participant,
        generation: endpoint.generation,
        attachment: endpoint.attachment,
        deliveryAvailable: endpoint.wakeAddress !== undefined,
        unreadCount: facts.directedCount(endpoint.participant, { unseenOnly: true, currentGeneration: true }),
      })), control?.signal)).value;
  }
  async detach(name: string, identity: { readonly owner: Owner; readonly generation: string }): Promise<true | null> {
    const ref: EndpointRef = { participant: name, ...identity };
    const current = await this.held(name, ref);
    if (current === undefined) return null;
    return (await this.artifact.transactAs({ kind: 'endpoint-cleanup', seat: ref },
      facts => facts.detachEndpoint(ref) ? true : null)).value;
  }
  async cancelDeliveries(name: string, identity: { readonly owner: Owner; readonly generation: string }, control?: OperationControl): Promise<boolean> {
    const ref: EndpointRef = { participant: name, ...identity };
    const current = await this.held(name, ref);
    if (current === undefined) return false;
    return (await this.artifact.transactAs({ kind: 'participant', seat: ref }, facts => {
      const boundary = facts.header().lastMessageIndex;
      return boundary < 0 ? false : facts.cancelThrough(ref, boundary);
    }, control?.signal)).value;
  }
  async remove(name: string, identity: { readonly owner: Owner; readonly generation: string }): Promise<boolean> {
    const ref: EndpointRef = { participant: name, ...identity };
    const current = await this.held(name, ref);
    if (current === undefined) return false;
    return (await this.artifact.transactAs({ kind: 'endpoint-cleanup', seat: ref },
      facts => facts.removeEndpoint(ref))).value;
  }
  private async held(name: string, identity: EndpointRef): Promise<EndpointFact | undefined> {
    const current = (await this.artifact.read(facts => facts.endpoint(name))).value;
    return current?.generation === identity.generation && current.owner === identity.owner ? current : undefined;
  }

  /** Commit one message, then run the shared custody runner outside the transaction. */
  async send(input: ChannelSendInput, control?: OperationControl): Promise<ChannelSendResult> {
    checkControl(control);
    const { from } = input;
    if (typeof from !== 'string') throw new SquareError('invalid_args', 'Channel sender must be a name.');
    validateName(from);
    return this.sendAs({ kind: 'send', actor: from }, input, control);
  }
  async sendAs(authority: ChannelWriteAuthority, input: ChannelSendInput, control?: OperationControl): Promise<ChannelSendResult> {
    checkControl(control);
    const { from, to, body, truncate = false } = input;
    const targets = typeof to === 'string' ? [to] : to;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 10)
      throw new SquareError('invalid_args', 'Channel needs between 1 and 10 recipients.');
    const unique: string[] = [];
    for (const target of targets) {
      if (typeof target !== 'string') throw new SquareError('invalid_args', 'Channel recipients must be names.');
      validateName(target);
      if (!unique.some(name => sameName(name, target))) unique.push(target);
    }
    if (typeof body !== 'string' || body.trim() === '') throw new SquareError('invalid_args', 'Channel body must be non-empty.');
    if (truncate !== false && (!Number.isSafeInteger(truncate) || truncate < 1))
      throw new SquareError('invalid_args', 'Channel truncate must be false or a positive integer.');
    const fullBody = body.replace(/\r\n/g, '\n');
    const preview = truncate !== false && fullBody.length > truncate
      ? `${fullBody.slice(0, truncate).trimEnd()}… (truncated ${fullBody.length - truncate} chars)` : undefined;
    const metadata = validateMessageMetadata(input.metadata);
    const { published, addresses } = (await this.artifact.transactAs(authority, (facts: ChannelWrite) => {
      const current = facts;
      const resolved = unique.flatMap(target => { const endpoint = current.endpoint(target); return endpoint === undefined ? [] : [endpoint]; });
      const missing = unique.filter(target => !resolved.some(endpoint => sameName(endpoint.participant, target)));
      if (missing.length > 0) throw new SquareError('invalid_args', `Channel recipients are not standing: ${missing.join(', ')}`, {
        reason: 'not_standing', targets: missing, activityUnsent: true,
      });
      const draft: MessageDraft = { from, at: this.clock(), body: fullBody,
        ...(messageMetadataHasContent(metadata) ? { metadata } : {}), ...(preview === undefined ? {} : { preview }),
        // An ordinary Channel send captures no endpoint generation: the message survives takeover until consumed.
        to: resolved.map(({ participant }) => ({ recipient: participant })) };
      const published = current.publishMessage(draft);
      return { published, addresses: current.addresses(published.index).map(address => address.recipient) };
    }, control?.signal)).value;
    await this.deliver(published.index);
    return { id: formatMessageId(published.index), at: published.at, from, to: addresses, body: fullBody,
      ...(published.metadata === undefined ? {} : { metadata: published.metadata }) };
  }

  /** Shared post-commit custody runner. */
  async deliver(message?: number): Promise<void> {
    await this.deliverEffect?.(message).catch(() => undefined);
  }

  async history(query: ChannelHistoryQuery = {}, control?: OperationControl): Promise<ChannelHistoryResult> {
    checkControl(control);
    const limit = query.limit === undefined ? 100 : query.limit;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
      throw new SquareError('invalid_args', 'History limit must be a positive integer no greater than 100.');
    if (query.order !== undefined && query.order !== 'asc' && query.order !== 'desc')
      throw new SquareError('invalid_args', 'History order must be asc or desc.');
    const filter: MessageFilter = {
      ...(query.at === undefined ? {} : { indexes: query.at.map(requireMessageIndex) }),
      ...(query.from === undefined ? {} : { senders: query.from }),
      ...(query.match === undefined ? {} : { metadataMatch: validateMetadataMatch(query.match) }),
      ...(query.search === undefined ? {} : { search: channelSearch(query.search) }),
      ...(query.cursor === undefined ? {} : query.cursor.direction === 'after' ? { afterIndex: requireMessageIndex(query.cursor.id) } : { beforeIndex: requireMessageIndex(query.cursor.id) }),
    };
    return (await this.artifact.read(facts => {
      const current = facts;
      const count = current.messageCount(filter);
      const page = current.messageHeads(filter, { edge: query.cursor?.direction === 'after' ? 'oldest' : 'newest', limit: limit ?? Math.max(1, count) });
      const messages = page.items.map(item => channelMessage(item, current));
      if (query.order === 'desc') messages.reverse();
      return { messages };
    }, control?.signal)).value;
  }

  async close(): Promise<void> {
    if (this.closesArtifact) await this.artifact.close();
  }
}

function requireMessageIndex(id: string): number {
  const index = parseMessageId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid message id: ${id}`);
  return index;
}
function channelMessage(item: MessageFact, facts: ChannelRead): ChannelMessage {
  return { id: formatMessageId(item.index), at: item.at, from: item.from,
    to: facts.addresses(item.index).map(address => address.recipient), body: item.body,
    ...(item.metadata === undefined ? {} : { metadata: item.metadata }), ...(item.preview === undefined ? {} : { preview: item.preview }) };
}
function channelSearch(search: { readonly text: string; readonly mode: 'literal' | 'regex' }) {
  if (typeof search !== 'object' || search === null || typeof search.text !== 'string' || search.text === ''
    || (search.mode !== 'literal' && search.mode !== 'regex') || Object.keys(search).some(key => key !== 'text' && key !== 'mode'))
    throw new SquareError('invalid_args', 'Query search requires non-empty text and literal/regex mode.');
  compileSearchPattern(search.text, search.mode === 'literal');
  return { text: search.text, mode: search.mode };
}

function channelPendingSelection(options: ChannelPendingOptions) {
  const limit = options.limit === undefined ? 100 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new SquareError('invalid_args', 'Pending limit must be a positive integer no greater than 100.');
  const filter: MessageFilter = {
    ...(options.at === undefined ? {} : { indexes: options.at.map(requireMessageIndex) }),
    ...(options.from === undefined ? {} : { senders: options.from }),
    ...(options.match === undefined ? {} : { metadataMatch: validateMetadataMatch(options.match) }),
    ...(options.search === undefined ? {} : { search: channelSearch(options.search) }),
    ...(options.cursor === undefined ? {} : options.cursor.direction === 'after' ? { afterIndex: requireMessageIndex(options.cursor.id) } : { beforeIndex: requireMessageIndex(options.cursor.id) }),
    unseenOnly: true, currentGeneration: true,
  };
  return { limit, filter };
}
/** Captures one recipient endpoint through the channel's own storage, never a wrapped square. */
export class ChannelEndpoint {
  constructor(private readonly channel: Channel, private readonly endpointFact: EndpointFact) { }
  get name(): string { return this.endpointFact.participant; }
  get generation(): string { return this.endpointFact.generation; }
  get ref(): EndpointRef { return this.endpointFact; }

  private get storage(): ChannelArtifact { return this.channel.artifact; }
  private get participant(): string { return this.endpointFact.participant; }

  async pending(options: ChannelPendingOptions = {}, control?: OperationControl): Promise<ChannelPendingResult> {
    checkControl(control);
    const { limit, filter } = channelPendingSelection(options);
    return (await this.storage.read(facts => {
      assertEndpoint(facts, this.endpointFact);
      const page = facts.directed(this.participant, filter, { edge: 'oldest', limit });
      const loaded = new Map(facts.messages(page.items.map(item => item.index)).map(item => [item.index, item]));
      return { messages: page.items.flatMap(head => { const item = loaded.get(head.index); return item === undefined ? [] : [channelMessage(item, facts)]; }),
        remaining: facts.directedCount(this.participant, filter) - page.items.length };
    }, control?.signal)).value;
  }
  async ack(ids: readonly MessageId[], control?: OperationControl): Promise<AckResult> {
    checkControl(control);
    if (!Array.isArray(ids)) throw new SquareError('invalid_args', 'Ack requires an array of message IDs.');
    const indexes = [...new Set(Array.from(ids, requireMessageIndex))];
    return (await this.storage.transactAs({ kind: 'participant', seat: this.endpointFact }, (facts: ChannelWrite) => {
      for (const index of indexes) {
        if (facts.directed(this.participant, { afterIndex: index - 1, throughIndex: index, currentGeneration: true }, { edge: 'oldest', limit: 1 }).items.length === 0)
          throw new SquareError('invalid_args', `${formatMessageId(index)} is not addressed to you.`, {
            reason: 'not_addressed', activityId: formatMessageId(index),
          });
      }
      return { consumed: facts.markSeen(this.participant, indexes, this.channel.clock()) };
    }, control?.signal)).value;
  }
  /** Select and consume matching unconsumed messages in one transaction. */
  async receive(options: ChannelPendingOptions = {}, control?: OperationControl): Promise<ChannelReceiveResult> {
    checkControl(control);
    const { limit, filter } = channelPendingSelection(options);
    return (await this.storage.transactAs({ kind: 'participant', seat: this.endpointFact }, (facts: ChannelWrite) => {
      const lower = facts;
      const consumed = consumeReceived({ heads: (recipient, query, page) => lower.directed(recipient, query, { edge: 'oldest', limit: page.limit }).items.map(item => ({ key: item.index, via: item })),
        addressed: (recipient, index) => { const head = lower.directed(recipient, { indexes: [index] }, { edge: 'oldest', limit: 1 }).items[0]; return head === undefined ? undefined : { key: head.index, via: head }; },
        load: (keys) => new Map(lower.messages(keys).map(item => [item.index, item])),
        count: (recipient, query) => lower.directedCount(recipient, query), insertReceipt: (ref, at) => lower.markSeen(ref.recipient, [ref.item], at) > 0,
      }, this.participant, { kind: 'page', query: filter, limit }, this.channel.clock());
      return { messages: consumed.items.map(item => channelMessage(item.data, lower)),
        consumed: consumed.newlyConsumed, remaining: consumed.remaining };
    }, control?.signal)).value;
  }
  async deferDelivery(input: Readonly<{ match: MetadataMatch; durationMs: number }>, control?: OperationControl): Promise<DeliveryDeferral> {
    checkControl(control);
    const match = validateMetadataMatch(input?.match), duration = validateDeferralDuration(input?.durationMs);
    return (await this.storage.transactAs({ kind: 'participant', seat: this.endpointFact }, (facts: ChannelWrite) => {
      const now = this.channel.clock(), expiresAt = now + duration, id = crypto.randomUUID();
      const result = { id, expiresAt: new Date(expiresAt).toISOString() };
      facts.putDeliveryDeferral(this.endpointFact, id, match, expiresAt, now);
      return result;
    }, control?.signal)).value;
  }
  async renewDeliveryDeferral(id: string, durationMs: number, control?: OperationControl): Promise<DeliveryDeferral | null> {
    checkControl(control);
    validateDeferralId(id);
    const duration = validateDeferralDuration(durationMs);
    return (await this.storage.transactAs({ kind: 'participant', seat: this.endpointFact }, (facts: ChannelWrite) => {
      const now = this.channel.clock(), expiresAt = now + duration;
      const result = { id, expiresAt: new Date(expiresAt).toISOString() };
      return facts.renewDeliveryDeferral(this.endpointFact, id, expiresAt, now) ? result : null;
    }, control?.signal)).value;
  }
  async releaseDeliveryDeferral(id: string, control?: OperationControl): Promise<boolean> {
    checkControl(control);
    validateDeferralId(id);
    return (await this.storage.transactAs({ kind: 'participant', seat: this.endpointFact }, (facts: ChannelWrite) =>
      facts.releaseDeliveryDeferral(this.endpointFact, id, this.channel.clock()), control?.signal)).value;
  }
  send(input: Omit<ChannelSendInput, 'from'>, control?: OperationControl): Promise<ChannelSendResult> {
    return this.channel.sendAs({ kind: 'participant', seat: this.endpointFact }, { ...input, from: this.participant }, control);
  }
  /** Standalone Channel retirement; it ends no Agora membership. */
  async leave(control?: OperationControl): Promise<void> {
    checkControl(control);
    const current = (await this.storage.read(facts => facts.endpoint(this.participant), control?.signal)).value;
    if (current === undefined || current.owner !== this.endpointFact.owner || current.generation !== this.endpointFact.generation || current.attachment !== 'attached')
      throw new SquareError('already_joined', 'This participant endpoint is not attached.');
    await this.channel.remove(this.participant, { owner: this.endpointFact.owner, generation: this.endpointFact.generation });
  }
}
function assertEndpoint(facts: ChannelRead, expected: EndpointRef): void {
  const current = facts.endpoint(expected.participant);
  if (current === undefined || current.owner !== expected.owner || current.generation !== expected.generation)
    throw new SquareError('already_joined', 'This participant endpoint has been replaced.');
  if (current.attachment !== 'attached')
    throw new SquareError('already_joined', 'This participant is away; attach again before writing.', { reason: 'needs_seat', activityUnsent: true });
}
export { validateEndpointGeneration };
