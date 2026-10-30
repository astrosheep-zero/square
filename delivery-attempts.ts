export type DeliveryPurpose = 'dispatch' | 'presentation';
export type AttemptOutcome = 'dispatching' | 'accepted' | 'failed' | 'unknown' | 'released' | 'presented' | 'clipped';

export interface Attempt<D> {
  readonly purpose: DeliveryPurpose;
  readonly token: string;
  readonly ordinal: number;
  readonly outcome: AttemptOutcome;
  readonly at: number;
  readonly expiresAt?: number;
  readonly data: D;
}

/** One item/recipient/authority/purpose series, bound inside the caller's transaction.
 * The caller owns token uniqueness, isolation and rollback; replacements retain coordinates.
 */
export interface AttemptRows<D> {
  list(): readonly Attempt<D>[]; // newest ordinal first
  byToken(token: string): Attempt<D> | undefined;
  insert(attempt: Attempt<D>): void;
  replace(attempt: Attempt<D>): void;
}
export type AttemptClaim<D> =
  | { readonly status: 'acquired'; readonly token: string; readonly ordinal: number }
  | { readonly status: 'busy' | 'terminal'; readonly evidence: Attempt<D>; readonly interrupted?: true };

function finite(value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('time must be finite');
}
function token(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('token must be nonempty');
}

export function claimAttempt<D>(rows: AttemptRows<D>, input: {
  purpose: DeliveryPurpose; token: string; at: number; leaseMs: number; data: D;
}): AttemptClaim<D> {
  if (input.purpose !== 'dispatch' && input.purpose !== 'presentation') throw new TypeError('unsupported purpose');
  token(input.token);
  finite(input.at);
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) throw new RangeError('leaseMs must be a positive safe integer');
  const expiresAt = input.at + input.leaseMs;
  finite(expiresAt);
  const attempts = rows.list();
  const terminal = attempts.find(row => row.outcome === 'unknown'
    || row.outcome === (input.purpose === 'dispatch' ? 'accepted' : 'presented'));
  if (terminal !== undefined) return { status: 'terminal', evidence: terminal };
  const dispatching = attempts.find(row => row.outcome === 'dispatching');
  if (dispatching !== undefined) {
    if (dispatching.expiresAt === undefined || dispatching.expiresAt > input.at) return { status: 'busy', evidence: dispatching };
    const { expiresAt: _expiry, ...previous } = dispatching;
    const evidence: Attempt<D> = { ...previous, outcome: 'unknown', at: input.at };
    rows.replace(evidence);
    return { status: 'terminal', evidence, interrupted: true };
  }
  const ordinal = (attempts[0]?.ordinal ?? -1) + 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new RangeError('attempt ordinal exhausted');
  rows.insert({ purpose: input.purpose, token: input.token, ordinal, outcome: 'dispatching', at: input.at, expiresAt, data: input.data });
  return { status: 'acquired', token: input.token, ordinal };
}

export function prepareAttempt<D>(rows: AttemptRows<D>, input: { token: string; data: D }): boolean {
  token(input.token);
  const previous = rows.byToken(input.token);
  if (previous?.outcome !== 'dispatching') return false;
  rows.replace({ ...previous, data: input.data });
  return true;
}

export function settleAttempt<D>(rows: AttemptRows<D>, input: {
  token: string; outcome: Exclude<AttemptOutcome, 'dispatching'>; at: number; data: D;
}): boolean {
  token(input.token);
  finite(input.at);
  if (!['accepted', 'failed', 'unknown', 'released', 'presented', 'clipped'].includes(input.outcome)) throw new TypeError('unsupported completion');
  const previous = rows.byToken(input.token);
  if (previous === undefined) return false;
  if (previous.outcome === 'accepted' && input.outcome === 'accepted') return true;
  if (previous.outcome !== 'dispatching' && !(previous.outcome === 'unknown' && input.outcome === 'accepted')) return false;
  const { expiresAt: _expiry, ...retained } = previous;
  rows.replace({ ...retained, outcome: input.outcome, at: input.at, data: input.data });
  return true;
}

type Custody = Pick<Attempt<unknown>, 'purpose' | 'outcome' | 'expiresAt'>;

/** Presentation custody suppresses dispatch independently of dispatch acceptance. */
export function presentationBlocksDispatch(attempts: readonly Custody[], now: number): boolean {
  finite(now);
  return attempts.some(row => row.purpose === 'presentation'
    && (row.outcome === 'presented' || row.outcome === 'clipped' || row.outcome === 'unknown'
      || row.outcome === 'dispatching' && (row.expiresAt === undefined || row.expiresAt > now)));
}

/** An expired dispatch is uncertain, not permission for automatic replay. */
export function automaticDispatchEligible(attempts: readonly Custody[], now: number): boolean {
  return !presentationBlocksDispatch(attempts, now) && !attempts.some(row => row.purpose === 'dispatch'
    && (row.outcome === 'accepted' || row.outcome === 'unknown' || row.outcome === 'dispatching'));
}
