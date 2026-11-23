import type { ActDraft, HydratedAct, Owner, HardCap, Seat, StoredAct, WakeAddress, WatchLease, DirectedNotificationRoute, ActivityMetadata } from './model.js';
import type { IndexPage, FactPage } from './neutral.js';
import type { MetadataMatch } from './delivery-deferral.js';
import type { SquarePostIdentity, SquarePostKeyFacts } from './delivery-key.js';

export interface ActivitySearch { readonly text: string; readonly mode: 'literal' | 'regex' }

/** Producer notices are not activities in the square. */
export type NotificationId = `notice/${number}`;
export interface SendInput {
  readonly from: string;
  readonly to: string | readonly string[];
  readonly body: string;
  readonly metadata?: ActivityMetadata;
}
export interface SendResult {
  readonly id: NotificationId;
  readonly at: number;
  readonly from: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly metadata?: ActivityMetadata;
}
/** The caller supplies every scalar equality identifying one exact outcome. */
export interface FutureAck {
  readonly from: string;
  readonly match: MetadataMatch;
  readonly future: 'exact';
}
/** One Square-owned recipient card; neither an endpoint nor a shared message resource. */
export interface SquarePost extends SquarePostKeyFacts {
  readonly owner: Owner;
  readonly from: string;
  readonly at: number;
  readonly body?: string;
  readonly metadata?: ActivityMetadata;
  readonly route?: DirectedNotificationRoute;
  readonly full?: boolean;
  readonly consumed?: boolean;
}
/** Identity and consumption facts only; withdrawal never needs card content. */
export type SquarePostDisposition = Pick<SquarePost, 'kind' | 'index' | 'recipient' | 'owner' | 'generation' | 'consumed'>;
export interface ProducerDeparture extends SeatRef { readonly token: string }
export interface ProducerRead {
  receiptWatermark(owner: Owner): number;
  departedSeats(): readonly ProducerDeparture[];
  pendingPosts(now?: number): readonly SquarePost[];
  postsAt(identities: readonly SquarePostIdentity[], selection?: 'receipt'): readonly SquarePost[];
  postDispositionsAt(identities: readonly SquarePostIdentity[]): readonly SquarePostDisposition[];
  withdrawnClaims(now: number): readonly SquarePostDisposition[];
  ownsPost(token: string, exportAt?: number): boolean;
}
export interface ProducerWrite {
  advanceReceiptWatermark(owner: Owner, seq: number): void;
  clearDepartedSeat(seat: ProducerDeparture): void;
  insertNotice(input: SendInput, at: number): SendResult;
  ackMatching(seat: SeatRef, input: FutureAck, at: number): number;
  acquirePost(post: SquarePost, token: string, pid: number, now: number, exportAt?: number): false | 'initial' | 'recovered';
  settlePost(token: string, full: boolean, disposition: 'posted' | 'uncertain' | 'never-exported'): boolean;
  foldReceipt(post: SquarePost, at: number): boolean;
}

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
  readonly actors?: readonly string[]; readonly actorMatch?: 'identity' | 'exact'; readonly afterAt?: number; readonly beforeAt?: number;
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
  recentSayTimes(afterExclusive: number, takeLatest: number): readonly number[];
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
  changed(sinceVersion: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
