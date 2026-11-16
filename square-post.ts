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
export interface SquarePostIdentity {
  readonly kind: SquarePost['kind'];
  readonly index: number;
  readonly recipientKey: string;
  readonly generation: string;
}
export interface ProducerRead {
  pendingPosts(now?: number): readonly SquarePost[];
  postsAt(identities: readonly SquarePostIdentity[]): readonly SquarePost[];
  withdrawnClaims(now: number): readonly SquarePost[];
  ownsPost(token: string, exportAt?: number): boolean;
}
export interface ProducerWrite {
  insertNotice(input: SendInput, at: number): SendResult;
  ackMatching(seat: SeatRef, input: FutureAck, at: number): number;
  acquirePost(post: SquarePost, token: string, pid: number, now: number, exportAt?: number): false | 'initial' | 'recovered';
  settlePost(token: string, full: boolean, disposition: 'posted' | 'uncertain' | 'never-exported'): boolean;
  foldReceipt(post: SquarePost, at: number): boolean;
}
export function squarePostKey(location: string, post: Pick<SquarePost, 'kind' | 'index' | 'recipient' | 'generation'>): string {
  return `square:${location}#${post.kind === 'activity' ? 'act' : 'notice'}/${post.index}/recipient/${encodeURIComponent(nameKey(post.recipient))}/join/${encodeURIComponent(post.generation)}`;
}
/** Only canonical keys from this square identify producer records. */
export function parseSquarePostKey(location: string, key: string): SquarePostIdentity | undefined {
  const prefix = `square:${location}#`;
  if (!key.startsWith(prefix)) return undefined;
  const match = /^(act|notice)\/(0|[1-9]\d*)\/recipient\/([^/]*)\/join\/([^/]*)$/.exec(key.slice(prefix.length));
  if (!match) return undefined;
  try {
    const index = Number(match[2]), recipientKey = decodeURIComponent(match[3]!), generation = decodeURIComponent(match[4]!);
    const kind = match[1] === 'act' ? 'activity' : 'notice';
    if (!Number.isSafeInteger(index) || squarePostKey(location, { kind, index, recipient: recipientKey, generation }) !== key) return undefined;
    return { kind, index, recipientKey, generation };
  } catch { return undefined; }
}
