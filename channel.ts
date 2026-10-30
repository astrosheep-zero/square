import { codexWakeAddress } from './codex-address.js';
import { SquareError } from './model.js';
import { harnessOwner } from './owner.js';
import { harnessSessionSources, type HarnessSessionChannel } from './participant-identity.js';
import type { SquareResourceOwner, WakeTransportPort } from './ports.js';
import { Square } from './square-api.js';
import type { ActivityId, ChannelSendInput, ChannelSendResult, DeliveryDeferral, HeldSeat, MetadataMatch,
  OperationControl, Owner, Participant, WakeAddress } from './square-facade.js';
import { squareLocation } from './square-location.js';

export { harnessOwner, decodeHarnessOwner, localUserOwner } from './owner.js';
export type { ActivityDelivery, ActivityMetadata, ChannelTruncate } from './square-facade.js';
export type { ActivityId, ChannelSendInput, ChannelSendResult, DeliveryDeferral, HeldSeat, MetadataMatch,
  OperationControl, Owner, WakeAddress, SquareResourceOwner, WakeTransportPort, HarnessSessionChannel };

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
  readonly wakeTransport?: WakeTransportPort | false;
  readonly resources?: SquareResourceOwner;
}
export interface ChannelCreateInput extends ChannelOpenInput {
  readonly force?: boolean;
  readonly description?: string;
}

type EndpointOptions = { readonly owner: Owner; readonly wakeAddress?: WakeAddress };
type EndpointIdentity = { readonly owner: Owner; readonly generation: ActivityId };

function explicitLocation(input: ChannelOpenInput): string {
  if (typeof input?.path !== 'string' || input.path.trim() === '')
    throw new SquareError('invalid_args', 'Channel path is required.');
  return squareLocation(input);
}

/** A scoped direct-messaging vocabulary over the shared Square resource. */
export class Channel {
  private constructor(private readonly square: Square) { }
  get location(): string { return this.square.location; }

  static async open(input: ChannelOpenInput, control?: OperationControl): Promise<Channel> {
    const path = explicitLocation(input);
    return new Channel(await Square.at({ ...input, path }, control));
  }
  static async create(input: ChannelCreateInput, control?: OperationControl): Promise<Channel> {
    const path = explicitLocation(input);
    return new Channel(await Square.build({ ...input, path, hardCap: null, markdown: input.description ?? '# Channel\n' }, control));
  }
  static inMemory(input: Omit<ChannelCreateInput, 'path' | 'resources' | 'force'> = {}): Channel {
    return new Channel(Square.inMemory({ ...input, hardCap: null, markdown: input.description ?? '# Channel\n' }));
  }

  async attach(name: string, options: EndpointOptions & { readonly takeover?: boolean }, control?: OperationControl): Promise<ChannelEndpoint> {
    return new ChannelEndpoint(this, (await this.square.join(name, options, control)).participant);
  }
  async reattach(name: string, options: EndpointOptions, control?: OperationControl): Promise<ChannelEndpoint | null> {
    const participant = await this.square.reattach(name, options, control);
    return participant === null ? null : new ChannelEndpoint(this, participant);
  }
  async endpoint(name: string, options: { readonly owner: Owner }): Promise<ChannelEndpoint> {
    return new ChannelEndpoint(this, await this.square.participant(name, options));
  }
  endpointsOf(owner: Owner): Promise<readonly HeldSeat[]> { return this.square.seatsOf(owner); }
  detach(name: string, identity: EndpointIdentity): Promise<true | null> { return this.square.detach(name, identity); }
  async remove(name: string, identity: EndpointIdentity): Promise<boolean> { return await this.square.endHeld(name, identity) !== null; }
  cancelDeliveries(name: string, identity: EndpointIdentity): Promise<boolean> { return this.square.cancelDeliveries(name, identity); }
  send(input: ChannelSendInput, control?: OperationControl): Promise<ChannelSendResult> { return this.square.send(input, control); }
  close(): Promise<void> { return this.square.close(); }
}

/** Captures one recipient generation through its existing Participant handle. */
export class ChannelEndpoint {
  constructor(private readonly channel: Channel, private readonly participant: Participant) { }
  get name(): string { return this.participant.name; }
  get generation(): ActivityId { return this.participant.generation; }

  async leave(control?: OperationControl): Promise<void> { await this.participant.done(undefined, {}, control); }
  deferDelivery(input: Readonly<{ match: MetadataMatch; durationMs: number }>, control?: OperationControl): Promise<DeliveryDeferral> {
    return this.participant.deferDelivery(input, control);
  }
  renewDeliveryDeferral(id: string, durationMs: number, control?: OperationControl): Promise<DeliveryDeferral | null> {
    return this.participant.renewDeliveryDeferral(id, durationMs, control);
  }
  releaseDeliveryDeferral(id: string, control?: OperationControl): Promise<boolean> {
    return this.participant.releaseDeliveryDeferral(id, control);
  }
  send(input: Omit<ChannelSendInput, 'from'>, control?: OperationControl): Promise<ChannelSendResult> {
    return this.channel.send({ ...input, from: this.name }, control);
  }
}
