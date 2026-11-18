import { deliveryKeyEqual, type DeliveryKey } from './delivery-key.js';
import { nameKey, type ActivityMetadata, type DirectedNotificationRoute, type Owner } from './model.js';
import type { MetadataMatch } from './delivery-deferral.js';
import type { SeatRef } from './ports.js';

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
export interface SquarePost {
  readonly kind: 'activity' | 'notice';
  readonly index: number;
  readonly recipient: string;
  readonly owner: Owner;
  readonly generation: string;
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
export interface SquarePostIdentity {
  readonly kind: SquarePost['kind'];
  readonly index: number;
  readonly recipientKey: string;
  readonly generation: string;
}
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
export function squarePostKey(location: string, post: Pick<SquarePost, 'kind' | 'index' | 'recipient' | 'generation'>): DeliveryKey {
  return ['square', location, 'recipient', nameKey(post.recipient), 'join', post.generation,
    post.kind === 'activity' ? 'act' : 'notice', String(post.index)];
}
/** Only canonical keys from this square identify producer records. */
export function parseSquarePostKey(location: string, key: DeliveryKey): SquarePostIdentity | undefined {
  if (!Array.isArray(key) || key.length !== 8 || !Array.from(key).every(segment => typeof segment === 'string')
    || key[0] !== 'square' || key[1] !== location
    || key[2] !== 'recipient' || key[4] !== 'join' || !['act', 'notice'].includes(key[6]!) || !/^(0|[1-9]\d*)$/.test(key[7]!)) return undefined;
  const index = Number(key[7]), recipientKey = key[3]!, generation = key[5]!;
  const kind = key[6] === 'act' ? 'activity' : 'notice';
  if (!Number.isSafeInteger(index) || !deliveryKeyEqual(squarePostKey(location, { kind, index, recipient: recipientKey, generation }), key)) return undefined;
  return { kind, index, recipientKey, generation };
}
