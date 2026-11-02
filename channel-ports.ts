import type { Owner } from './neutral.js';
import type { MessageMetadata, JsonValue, WakeAddress } from './channel-values.js';
import type { MetadataMatch, DeliveryDeferralFact } from './delivery-deferral.js';
import type { AttemptOutcome } from './delivery-attempts.js';
import type { MessageId } from './message.js';
import type { EndpointGeneration } from './message.js';

export type { MessageId, EndpointGeneration };
/** One lower write's custody claim. Every Channel mutation carries exactly one. */
export type ChannelWriteAuthority =
  | { readonly kind: 'send'; readonly actor: string }
  | { readonly kind: 'endpoint'; readonly participant: string; readonly owner: Owner }
  | { readonly kind: 'endpoint-cleanup'; readonly seat: EndpointRef }
  | { readonly kind: 'participant'; readonly seat: EndpointRef };
/** The only storage surface a Channel is allowed to see: messages, endpoints and their custody. */
export interface ChannelArtifact {
  read<T>(select: (facts: ChannelRead) => T, signal?: AbortSignal): Promise<{ readonly value: T; readonly version: number }>;
  transactAs<T>(authority: ChannelWriteAuthority, change: (facts: ChannelWrite) => T, signal?: AbortSignal): Promise<{ readonly value: T; readonly changed: boolean }>;
  claimDelivery(input: ChannelDeliveryClaimInput, signal?: AbortSignal): Promise<ChannelDeliveryClaimResult>;
  prepareDelivery(input: ChannelDeliveryPreparation, signal?: AbortSignal): Promise<boolean>;
  completeDelivery(input: ChannelDeliveryCompletion, signal?: AbortSignal): Promise<boolean>;
  cancelDeliveries(seat: EndpointRef, through?: number, signal?: AbortSignal): Promise<boolean>;
  changed(sinceVersion: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
export interface ChannelHeader {
  readonly revision: number;
  readonly deliveryRevision: number;
  readonly nextMessageIndex: number;
  readonly lastMessageIndex: number;
}
/** One Channel message. Body and caller metadata have exactly one authoritative copy. */
export interface MessageFact {
  readonly index: number;
  readonly at: number;
  readonly from: string;
  readonly body: string;
  readonly metadata?: MessageMetadata;
  /** Sender-chosen preview projection; the stored body remains full. */
  readonly preview?: string;
}
export interface MessageAddressFact {
  readonly recipient: string;
  readonly generation?: EndpointGeneration;
}
export interface MessageHead {
  readonly index: number;
  readonly at: number;
  readonly from: string;
  readonly recipient: string;
  readonly generation?: EndpointGeneration;
}
export interface MessageFilter {
  readonly afterIndex?: number;
  readonly beforeIndex?: number;
  readonly throughIndex?: number;
  readonly indexes?: readonly number[];
  readonly senders?: readonly string[];
  readonly senderMatch?: 'identity' | 'exact';
  readonly afterAt?: number;
  readonly metadataMatch?: MetadataMatch;
  readonly search?: { readonly text: string; readonly mode: 'literal' | 'regex' };
  readonly unseenOnly?: true;
  readonly currentGeneration?: true;
}
export interface MessageDraft {
  readonly from: string;
  readonly at: number;
  readonly body: string;
  readonly metadata?: MessageMetadata;
  readonly preview?: string;
  readonly to: readonly MessageAddressFact[];
}
export interface EndpointFact {
  readonly participant: string;
  readonly owner: Owner;
  readonly generation: EndpointGeneration;
  readonly attachment: 'attached' | 'detached';
  readonly wakeAddress?: WakeAddress;
}
export type EndpointRef = Pick<EndpointFact, 'participant' | 'owner' | 'generation'>;
/** Upper-owned namespace association; Channel never interprets its selector. */
export interface ReceiveClaimFact {
  readonly namespace: string;
  readonly id: string;
  readonly owner: string;
  readonly generation: EndpointGeneration;
  readonly selector: JsonValue;
  /** Message-scoped suppression coverage; Channel owns this list, the selector stays opaque. */
  readonly suppressed: readonly number[];
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}
export interface ChannelDeliveryEvidence {
  readonly participant: string;
  readonly generation: EndpointGeneration;
  readonly message: MessageId;
  readonly kind: 'wake' | 'presentation';
  readonly outcome: AttemptOutcome;
  readonly attemptN: number;
  readonly at: number;
  readonly expiresAt?: number;
  readonly claimToken?: string;
  readonly route?: WakeAddress;
  readonly signature?: string;
  readonly messageText?: string;
  readonly diagnostic?: JsonValue;
  readonly correlation?: {
    readonly harness: 'claude' | 'opencode' | 'pi';
    readonly token?: string;
    readonly messageId?: string;
    readonly payloadHash?: string;
  };
  /** Exact bytes prepared for this attempt; declared before the external effect. */
  readonly coverage?: 'full' | 'clipped';
  readonly description?: string;
  readonly nativeObservations?: readonly {
    readonly eventId: string;
    readonly messageId: string;
    readonly state: 'held' | 'released' | 'dropped';
    readonly reason?: string;
    readonly observedAt: number;
  }[];
}
export interface ChannelDeliveryClaimInput {
  readonly seat: EndpointRef;
  readonly message: MessageId;
  readonly kind: 'wake' | 'presentation';
  readonly observationOf?: string;
  readonly route?: WakeAddress;
  readonly at: number;
  readonly leaseMs: number;
  readonly claimToken: string;
}
export type ChannelDeliveryClaimResult =
  | { readonly status: 'acquired'; readonly claimToken: string; readonly attemptN: number }
  | { readonly status: 'busy' | 'terminal' | 'stale' | 'deferred'; readonly evidence?: ChannelDeliveryEvidence };
export interface ChannelDeliveryPreparation {
  readonly seat: EndpointRef;
  readonly claimToken: string;
  readonly correlation: NonNullable<ChannelDeliveryEvidence['correlation']>;
  readonly coverage: 'full' | 'clipped';
  readonly description?: string;
}
export interface ChannelDeliveryCompletion {
  readonly seat: EndpointRef;
  readonly message: MessageId;
  readonly claimToken: string;
  readonly outcome: Exclude<ChannelDeliveryEvidence['outcome'], 'dispatching'>;
  readonly at: number;
  readonly signature?: string;
  readonly messageText?: string;
  readonly diagnostic?: JsonValue;
  readonly correlation?: ChannelDeliveryEvidence['correlation'];
}

/** Lower read capabilities. Nothing here describes Agora events, routes or attention. */
export interface ChannelRead {
  header(): ChannelHeader;
  message(index: number): MessageFact | undefined;
  messages(indexes: readonly number[]): readonly MessageFact[];
  messageHeads(filter: MessageFilter, page: { readonly edge: 'oldest' | 'newest'; readonly limit: number }): {
    readonly items: readonly MessageFact[];
    readonly hasMore: boolean;
  };
  messageCount(filter: MessageFilter): number;
  addresses(index: number): readonly MessageAddressFact[];
  receipt(owner: string, index: number): { readonly at: number } | undefined;
  receiptFacts(owner: string, afterIndex: number): { readonly latestAt?: number; readonly latestActorMessageIndex?: number };
  directed(recipient: string, filter: MessageFilter, page: { readonly edge: 'oldest' | 'newest'; readonly limit: number }): {
    readonly items: readonly MessageHead[];
    readonly hasMore: boolean;
  };
  directedCount(recipient: string, filter: MessageFilter): number;
  endpoint(requested: string): EndpointFact | undefined;
  endpointsForOwner(owner: Owner): readonly EndpointFact[];
  endpoints(): readonly EndpointFact[];
  deliveryEvidence(participant: string, generation: EndpointGeneration, message?: MessageId): readonly ChannelDeliveryEvidence[];
  deliveryByToken(claimToken: string): ChannelDeliveryEvidence | undefined;
  cancelledThrough(participant: string, generation: EndpointGeneration): number | undefined;
  deliveryDeferrals(participant: string, generation: EndpointGeneration): readonly DeliveryDeferralFact[];
  receiveClaims(owner: string, namespace?: string): readonly ReceiveClaimFact[];
  claimLease(owner: string, namespace?: string): ReceiveClaimFact | undefined;
  /** Any live claim of this endpoint covering the message suppresses its pending eligibility. */
  suppressed(owner: string, generation: EndpointGeneration, index: number, now: number): boolean;
}

export interface ChannelWrite extends ChannelRead {
  publishMessage(draft: MessageDraft): MessageFact;
  storeEndpoint(endpoint: EndpointFact): boolean;
  updateWakeAddress(endpoint: EndpointRef, wakeAddress?: WakeAddress): boolean;
  reattachEndpoint(endpoint: EndpointRef, wakeAddress?: WakeAddress): boolean;
  detachEndpoint(endpoint: EndpointRef): boolean;
  removeEndpoint(endpoint: EndpointRef): boolean;
  cancelThrough(endpoint: EndpointRef, through: number): boolean;
  markSeen(owner: string, indexes: readonly number[], at: number): number;
  claimDelivery(input: ChannelDeliveryClaimInput): ChannelDeliveryClaimResult;
  prepareDelivery(input: ChannelDeliveryPreparation): boolean;
  completeDelivery(input: ChannelDeliveryCompletion): boolean;
  observeNativeDelivery(input: { readonly seat: EndpointRef; readonly claimToken: string; readonly observation: NonNullable<ChannelDeliveryEvidence['nativeObservations']>[number] }): boolean;
  putDeliveryDeferral(seat: EndpointRef, id: string, match: MetadataMatch, expiresAt: number, now: number): boolean;
  renewDeliveryDeferral(seat: EndpointRef, id: string, expiresAt: number, now: number): boolean;
  releaseDeliveryDeferral(seat: EndpointRef, id: string, now: number): boolean;
  putReceiveClaim(claim: ReceiveClaimFact): boolean;
  removeReceiveClaim(owner: string, namespace: string, id: string): boolean;
}
