import type { ActDraft, HydratedAct, Owner, HardCap, Seat, StoredAct, WakeAddress, WatchLease, DirectedNotificationRoute } from './model.js';
import type { ActivitySearch } from './square-facade.js';
import type { IndexPage, FactPage } from './neutral.js';
import type { MetadataMatch } from './delivery-deferral.js';
import type { ProducerRead, ProducerWrite } from './square-post.js';
export type { IndexPage, FactPage } from './neutral.js';

export type ActivityIndex = number;
export interface SquareHeader {
  readonly revision: number;
  readonly deliveryRevision: number;
  readonly nextActIndex: number;
  readonly lastActIndex: number;
  readonly hardCap: HardCap;
  readonly throttlePerMinute?: number;
  readonly preamble: readonly string[];
  readonly warmup: readonly string[];
}
export interface ParticipantFact {
  readonly name: string;
  readonly firstIndex: number;
  readonly joined: boolean;
  readonly done: boolean;
  readonly sayCount: number;
  readonly lastActiveAt?: number;
  readonly lastJoinIndex?: number;
}
export interface ParticipantCounts { readonly known: number; readonly joined: number; readonly done: number }
export interface AttentionFact { readonly listener: string; readonly target: string; readonly kind: 'listen' | 'ignore'; readonly sinceIndex: number }
export interface ActivityHead { readonly index: ActivityIndex; readonly at: number; readonly kind: StoredAct['kind']; readonly actor: string; readonly reach?: 'bell'; readonly reply?: ActivityIndex }
export interface ActivityFilter {
  readonly afterIndex?: number; readonly beforeIndex?: number; readonly throughIndex?: number;
  readonly indexes?: readonly ActivityIndex[]; readonly kinds?: readonly StoredAct['kind'][];
  readonly actors?: readonly string[]; readonly actorMatch?: 'identity' | 'exact'; readonly afterAt?: number;
  readonly metadataMatch?: MetadataMatch; readonly search?: ActivitySearch;
}
export interface DirectedFilter extends Omit<ActivityFilter, 'actors' | 'actorMatch'> {
  readonly unseenOnly?: true; readonly currentGeneration?: true; readonly senders?: readonly string[]; readonly attentionOnly?: true;
}
export interface DirectedHead {
  readonly index: ActivityIndex; readonly at: number; readonly actor: string; readonly recipient: string;
  readonly route: DirectedNotificationRoute; readonly generation?: string;
}
export interface LandedRecipient { readonly recipient: string; readonly route: DirectedNotificationRoute; readonly generation?: string; readonly owner?: Owner }
export interface ReceiptFacts { readonly latestAt?: number; readonly latestActorActivityIndex?: number }
export type SeatRef = Pick<Seat, 'participant' | 'owner' | 'generation'>;
export type ArtifactWriteAuthority =
  | { readonly kind: 'participant'; readonly seat: SeatRef }
  | { readonly kind: 'host-cleanup'; readonly seat: SeatRef }
  | { readonly kind: 'join'; readonly participant: string; readonly owner: Owner; readonly wakeAddress?: WakeAddress }
  | { readonly kind: 'takeover'; readonly participant: string; readonly owner: Owner; readonly expectedGeneration: string; readonly wakeAddress?: WakeAddress }
  | { readonly kind: 'producer' }
  | { readonly kind: 'send'; readonly actor: string };

/** All callbacks are synchronous and their facts cannot escape the transaction. */
export interface SquareRead extends ProducerRead {
  seat(name: string): Seat | undefined;
  seatsForOwner(owner: Owner): readonly Seat[];
  header(): SquareHeader;
  participant(name: string): ParticipantFact | undefined;
  participantCounts(): ParticipantCounts;
  roster(): readonly ParticipantFact[];
  attention(listener: string): readonly AttentionFact[];
  incomingAttention(sender: string): readonly AttentionFact[];
  activity(index: ActivityIndex): StoredAct | undefined;
  activityHeads(filter: ActivityFilter, page: IndexPage): FactPage<ActivityHead>;
  activities(indexes: readonly ActivityIndex[]): readonly HydratedAct[];
  activityCount(filter: ActivityFilter): number;
  contextIndexes(centers: readonly ActivityIndex[], before: number, after: number): readonly ActivityIndex[];
  sayOrdinals(indexes: readonly ActivityIndex[]): Readonly<Record<number, number>>;
  recentSayTimes(afterExclusive: number, takeLatest: number, actor?: string, bellOnly?: true): readonly number[];
  audience(index: ActivityIndex): readonly LandedRecipient[];
  directed(recipient: string, filter: DirectedFilter, page: IndexPage): FactPage<DirectedHead>;
  directedAt(recipient: string, index: ActivityIndex): DirectedHead | undefined;
  directedCount(recipient: string, filter: DirectedFilter): number;
  receipt(name: string, index: ActivityIndex): { readonly at: number } | undefined;
  receiptFacts(name: string, afterIndex: number): ReceiptFacts;
  lease(name: string): WatchLease | undefined;
}
export interface SquareWrite extends SquareRead, ProducerWrite {
  land(draft: ActDraft): StoredAct;
  putLease(name: string, lease: WatchLease, generation?: string): boolean;
  removeLease(name: string, expectedLeaseId: string, generation?: string): boolean;
  markSeen(recipient: string, indexes: readonly number[], at: number): number;
  setSeatAttachment(seat: SeatRef, attachment: 'attached' | 'detached'): boolean;
}
export interface SquareReadResult<R> { readonly value: R; readonly version: number }
export interface SquareCommitResult<R> extends SquareReadResult<R> { readonly changed: boolean }
export interface SquareArtifactPort {
  read<R>(select: (facts: SquareRead) => R, signal?: AbortSignal): Promise<SquareReadResult<R>>;
  transactAs<R>(authority: ArtifactWriteAuthority, change: (facts: SquareWrite) => R, signal?: AbortSignal): Promise<SquareCommitResult<R>>;
  settleAs<R>(authority: ArtifactWriteAuthority, change: (facts: SquareWrite) => R): Promise<SquareCommitResult<R>>;
  revision(signal?: AbortSignal): Promise<number>;
  deliveryRevision(signal?: AbortSignal): Promise<number>;
  changed(sinceVersion: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
