import { Channel as ChannelCore, ChannelEndpoint as EndpointCore, resolveHarnessSession as resolveSession } from './channel-internal.js';
import type { MessageMetadata, WakeAddress } from './channel-values.js';
import type { Owner, OperationControl } from './neutral.js';
import type { HarnessSessionChannel } from './participant-identity.js';
import type { WakeTransportPort } from './channel-transport.js';
import type { MetadataMatch, DeliveryDeferral } from './channel-metadata.js';
import type { MessageId } from './message.js';
import type { AckResult, ChannelEndpointHold, ChannelEndpointSummary, ChannelHistoryQuery, ChannelHistoryResult,
  ChannelPendingOptions, ChannelPendingResult, ChannelReceiveResult, ChannelSendInput, ChannelSendResult } from './channel-facade.js';

export { harnessOwner, decodeHarnessOwner, localUserOwner } from './owner.js';
export type { MessageMetadata, WakeAddress } from './channel-values.js';
export type { MessageId } from './message.js';
export type { MessageCursor, MessageQuery, MessageSearch, ChannelTruncate, ChannelSendInput, ChannelSendResult,
  ChannelMessage, ChannelPendingOptions, ChannelPendingResult, ChannelReceiveResult, ChannelHistoryQuery,
  ChannelHistoryResult, AckResult, ChannelEndpointSummary, ChannelEndpointHold } from './channel-facade.js';
export type { MetadataMatch, DeliveryDeferral } from './channel-metadata.js';
export type { Owner, OperationControl } from './neutral.js';
export type { WakeTransportPort } from './channel-transport.js';
export type { HarnessSessionChannel } from './participant-identity.js';

export interface ResolvedHarnessSession {
  readonly channel: HarnessSessionChannel;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly owner: Owner;
  readonly wakeAddress?: WakeAddress;
}
export function resolveHarnessSession(env: NodeJS.ProcessEnv = process.env): ResolvedHarnessSession | undefined {
  return resolveSession(env);
}
export interface ChannelOpenInput {
  readonly path: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => number;
  readonly wakeTransport?: WakeTransportPort | false;
}
export interface ChannelCreateInput extends ChannelOpenInput {
  readonly force?: boolean;
  readonly description?: string;
}
type EndpointOptions = { readonly owner: Owner; readonly wakeAddress?: WakeAddress };
type EndpointIdentity = { readonly owner: Owner; readonly generation: string };
const endpointKey = Symbol('ChannelEndpoint');
let wrapEndpoint: (core: EndpointCore) => ChannelEndpoint;

/** A trusted handle to one independent message channel. */
export class Channel {
  #core: ChannelCore;
  private constructor(core: ChannelCore) { this.#core = core; }
  static async open(input: ChannelOpenInput, control?: OperationControl): Promise<Channel> {
    return new Channel(await ChannelCore.open(input, control));
  }
  static async create(input: ChannelCreateInput, control?: OperationControl): Promise<Channel> {
    return new Channel(await ChannelCore.create(input, control));
  }
  static inMemory(input: Omit<ChannelCreateInput, 'path' | 'force'> = {}): Channel {
    return new Channel(ChannelCore.inMemory(input));
  }
  get location(): string { return this.#core.location; }
  async attach(name: string, options: EndpointOptions & { readonly takeover?: boolean }, control?: OperationControl): Promise<ChannelEndpoint> {
    return wrapEndpoint(await this.#core.attach(name, options, control));
  }
  async reattach(name: string, options: EndpointOptions, control?: OperationControl): Promise<ChannelEndpoint | null> {
    const endpoint = await this.#core.reattach(name, options, control);
    return endpoint === null ? null : wrapEndpoint(endpoint);
  }
  async endpoint(name: string, options: { readonly owner: Owner }): Promise<ChannelEndpoint> {
    return wrapEndpoint(await this.#core.endpoint(name, options));
  }
  endpointsOf(owner: Owner): Promise<readonly ChannelEndpointHold[]> { return this.#core.endpointsOf(owner); }
  listEndpoints(control?: OperationControl): Promise<readonly ChannelEndpointSummary[]> { return this.#core.listEndpoints(control); }
  detach(name: string, identity: EndpointIdentity): Promise<true | null> { return this.#core.detach(name, identity); }
  cancelDeliveries(name: string, identity: EndpointIdentity, control?: OperationControl): Promise<boolean> { return this.#core.cancelDeliveries(name, identity, control); }
  remove(name: string, identity: EndpointIdentity): Promise<boolean> { return this.#core.remove(name, identity); }
  send(input: ChannelSendInput, control?: OperationControl): Promise<ChannelSendResult> { return this.#core.send(input, control); }
  history(query?: ChannelHistoryQuery, control?: OperationControl): Promise<ChannelHistoryResult> { return this.#core.history(query, control); }
  close(): Promise<void> { return this.#core.close(); }
}

/** Fenced to one attached endpoint generation. */
export class ChannelEndpoint {
  #core: EndpointCore;
  private constructor(core: EndpointCore, key: symbol) {
    if (key !== endpointKey) throw new TypeError('Channel endpoints are obtained from a Channel.');
    this.#core = core;
  }
  static { wrapEndpoint = core => new ChannelEndpoint(core, endpointKey); }
  get name(): string { return this.#core.name; }
  get generation(): string { return this.#core.generation; }
  pending(options?: ChannelPendingOptions, control?: OperationControl): Promise<ChannelPendingResult> { return this.#core.pending(options, control); }
  ack(ids: readonly MessageId[], control?: OperationControl): Promise<AckResult> { return this.#core.ack(ids, control); }
  receive(options?: ChannelPendingOptions, control?: OperationControl): Promise<ChannelReceiveResult> { return this.#core.receive(options, control); }
  deferDelivery(input: Readonly<{ match: MetadataMatch; durationMs: number }>, control?: OperationControl): Promise<DeliveryDeferral> { return this.#core.deferDelivery(input, control); }
  renewDeliveryDeferral(id: string, durationMs: number, control?: OperationControl): Promise<DeliveryDeferral | null> { return this.#core.renewDeliveryDeferral(id, durationMs, control); }
  releaseDeliveryDeferral(id: string, control?: OperationControl): Promise<boolean> { return this.#core.releaseDeliveryDeferral(id, control); }
  send(input: Omit<ChannelSendInput, 'from'>, control?: OperationControl): Promise<ChannelSendResult> { return this.#core.send(input, control); }
  leave(control?: OperationControl): Promise<void> { return this.#core.leave(control); }
}
