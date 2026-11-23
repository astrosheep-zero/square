import path from 'node:path';

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
  | 'behind'
  | 'io'
  | 'unavailable';

export type InternalSquareErrorCode = SquareErrorCode
  | 'not_found'
  | 'cap_reached'
  | 'conflict'
  | 'pending_peer';

/** One speaker's unperceived activity, previewed by its latest body. */
export interface UnreadActivitySummary {
  readonly name: string;
  readonly count: number;
  readonly latestActivityAgeMs: number;
  readonly preview: { readonly body?: string; readonly structured: boolean };
}

export interface SquareErrorFacts {
  /** Express admission rejected before any activity was committed. */
  activityUnsent?: true;
  /** Refusal reason, including absent participants, conflicting reach, and inaccessible activities. */
  reason?: 'never_joined' | 'not_standing' | 'invalid_reply' | 'invalid_done_body' | 'needs_seat';
  /** The activity ID a reply refusal named. */
  activityId?: string;
  /** Requested recipient spellings, without parsing presentation copy. */
  targets?: readonly string[];
  /** Whether the artifact holds that activity at all; an unknown id needs an ordinary page. */
  activityExists?: boolean;
  /** Who spoke while an express was away; the refusal rests on exactly these. */
  activitySummaries?: readonly UnreadActivitySummary[];
  retryAfterMs?: number;
  /** A capped speaker's spoken count against the square's cap. */
  spoken?: number;
  hardCap?: number;
}

export interface PerceiveWaitStart {
  readonly waitMs: number;
  readonly replacementRequested: boolean;
  readonly replaced: boolean;
}
export type OperationProgress =
  | { readonly kind: 'waiting'; readonly reason: 'throttled'; readonly delayMs?: number }
  | ({ readonly kind: 'perceive-started'; readonly participant: string } & PerceiveWaitStart);
export interface OperationControl {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OperationProgress) => void;
}
export interface OperationFailureDetail {
  readonly operation: 'express' | 'join' | 'perceive' | 'history' | 'other';
  readonly subject?: 'caller' | 'filter' | 'recipient';
  readonly participant?: string;
  readonly expressEffect?: 'unsent' | 'landed' | 'unknown';
  readonly landedId?: string;
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

/** Request extra facts for rendering, without changing operation semantics. */
export interface ObservationOptions {
  readonly observe?: boolean;
}
/** A square is addressed by an explicit artifact path or a directory to discover in. */
export interface SquareLocation {
  readonly path?: string;
  readonly cwd?: string;
}

export function squareLocation(input: SquareLocation): string {
  const selected = input.path;
  if (selected === undefined || selected.trim() === '') throw new SquareError('invalid_args', 'Square needs a location');
  // Windows roots include drive-relative prefixes such as D:.
  if (path.win32.parse(selected).root === '' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(selected))
    throw new SquareError('invalid_args', 'Expected a local square artifact path');
  return path.resolve(input.cwd ?? process.cwd(), selected);
}

export function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Square operation was cancelled');
}
export function failure(error: unknown, detail: OperationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}

export function truncateChars(body: string, maxChars: number): { text: string; remaining: number } {
  const chars = [...body];
  if (chars.length <= maxChars) return { text: body, remaining: 0 };
  return { text: chars.slice(0, maxChars).join('').trimEnd(), remaining: chars.length - maxChars };
}
