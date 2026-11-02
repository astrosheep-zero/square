/** Shared identity, error and paging types used below both Channel and Agora. */
export type Owner = string;

export type SquareErrorCode =
  | 'invalid_name'
  | 'invalid_args'
  | 'unknown_participant'
  | 'not_joined'
  | 'already_joined'
  | 'already_done'
  | 'capped'
  | 'throttled'
  | 'bell_quota'
  | 'behind'
  | 'io'
  | 'unavailable';

export type InternalSquareErrorCode = SquareErrorCode
  | 'not_found'
  | 'cap_reached'
  | 'conflict'
  | 'pending_peer';

export interface SquareErrorFacts {
  /** Copyable recovery for a missing, detached or foreign seat. */
  join?: string;
  /** Express admission rejected before any activity was committed. */
  activityUnsent?: true;
  /** Refusal reason, including absent participants, conflicting reach, and inaccessible activities. */
  reason?: 'never_joined' | 'not_standing' | 'bell_mention_conflict' | 'not_addressed' | 'invalid_reply' | 'invalid_done_body' | 'needs_seat';
  /** The activity id a `catch --id` refusal named. */
  activityId?: string;
  /** Requested recipient spellings, without parsing presentation copy. */
  targets?: readonly string[];
  /** Whether the artifact holds that activity at all; an unknown id needs an ordinary page. */
  activityExists?: boolean;
  pending?: number;
  retryAfterMs?: number;
}

export interface CatchWaitStart {
  readonly idleMs: number;
  readonly replacementRequested: boolean;
  readonly replaced: boolean;
}
export type OperationProgress =
  | { readonly kind: 'waiting'; readonly reason: 'throttled'; readonly delayMs?: number }
  | ({ readonly kind: 'catch-started'; readonly participant: string } & CatchWaitStart);
export interface OperationControl {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OperationProgress) => void;
}
export interface OperationFailureDetail {
  readonly operation: 'express' | 'join' | 'catch' | 'history' | 'other';
  readonly subject?: 'caller' | 'filter' | 'recipient';
  readonly participant?: string;
  readonly expressEffect?: 'unsent' | 'landed' | 'unknown';
  readonly landedId?: string;
  readonly historyBounds?: { readonly maxLimit: number; readonly totalMatches: number };
}
export interface OperationError extends Error {
  readonly operation?: OperationFailureDetail;
}

export class SquareErrorBase<Code extends string> extends Error {
  operation?: OperationFailureDetail;
  constructor(public code: Code, message: string, public facts?: SquareErrorFacts) {
    super(message);
    this.name = 'SquareError';
  }
}
export class SquareError extends SquareErrorBase<SquareErrorCode> {}
export class InternalSquareError extends SquareErrorBase<InternalSquareErrorCode> {}

export function isSquareError(error: unknown): error is SquareError | InternalSquareError {
  return error instanceof SquareError || error instanceof InternalSquareError;
}

export function validateOwner(owner: Owner): Owner {
  if (typeof owner !== 'string' || !owner || Buffer.byteLength(owner, 'utf8') > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(owner)) {
    throw new SquareError('invalid_args', 'A participant write requires a non-empty owner without control characters (at most 512 UTF-8 bytes).');
  }
  return owner;
}
export function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

export interface IndexPage { readonly edge: 'oldest' | 'newest'; readonly limit: number }
export interface FactPage<T> { readonly items: readonly T[]; readonly hasMore: boolean }
