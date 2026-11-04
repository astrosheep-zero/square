import os from 'node:os';
import path from 'node:path';
import { validateOwner, type Owner } from './neutral.js';
import { observeFileMetadata, type VersionObserver } from './file-changes.js';
import { LedgerStore } from './delivery-ledger-sqlite.js';

export interface DeliveryRoute {
  readonly kind: string;
  readonly address: Readonly<Record<string, string>>;
}
export interface DeliverySession {
  readonly owner: Owner;
  readonly generation: string;
  readonly state: 'attached' | 'detached' | 'deleted';
  readonly routes: readonly DeliveryRoute[];
  readonly at: number;
}
export interface DeliveryCard {
  readonly seq: number;
  readonly owner: Owner;
  readonly key: string;
  readonly text: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly postedAt: number;
}
export interface DeliveryCorrelation {
  readonly token?: string;
  readonly messageId?: string;
  readonly payloadHash?: string;
}
export interface DeliveryHandoffRef {
  readonly token: string;
  readonly owner: Owner;
  readonly generation: string;
  readonly payloadHash: string;
  readonly routeKind: string;
}
export type DeliveryOutcome = 'dispatching' | 'accepted' | 'presented' | 'failed' | 'unknown' | 'released';
export type PresentationOutcome = 'presented' | 'failed' | 'unknown' | 'released';
export interface DeliveryAttempt {
  readonly token: string;
  readonly seq: number;
  readonly generation: string;
  readonly track: 'handoff' | 'presentation';
  readonly routeKind: string | null;
  readonly outcome: DeliveryOutcome;
  readonly correlation: DeliveryCorrelation;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly settledAt?: number;
}
export interface DeliveryReceipt { readonly owner: Owner; readonly key: string; readonly at: number }
export type PostResult = { readonly status: 'posted' | 'duplicate' | 'conflict' | 'unknown-session' | 'deleted-session' | 'suppressed' };
export type SuppressionResult = { readonly id: string; readonly status: 'suppressed' | 'in-custody' };
export interface DeliveryHealth {
  readonly unknownAttempts: readonly DeliveryAttempt[];
  readonly repeatedFailures: readonly { readonly owner: Owner; readonly key: string; readonly count: number }[];
  readonly sessionsWithoutRoute: readonly Owner[];
}
export interface PresentationClaim {
  readonly cards: readonly DeliveryCard[];
  readonly attempts: readonly DeliveryAttempt[];
  /** Recheck immediately before handing text to the external receiver. */
  current(signal?: AbortSignal): Promise<boolean>;
  /** Captured custody survives attachment rotation; errors propagate without a false receipt. */
  settle(outcome: PresentationOutcome): Promise<boolean>;
}
export interface DeliveryTransportContext {
  readonly token: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  prepare(correlation: DeliveryCorrelation): Promise<boolean>;
  /** Adapters with awaits before I/O recheck here, then check signal/deadline synchronously. */
  beforeSend(): Promise<boolean>;
}
export type TransportOutcome = 'accepted' | 'presented' | 'failed' | 'unknown' | 'not-capable';
export interface DeliveryTransport {
  readonly kind: string;
  send(card: DeliveryCard, address: Readonly<Record<string, string>>, context: DeliveryTransportContext): Promise<TransportOutcome>;
}
export interface LateHandoffSettlement {
  readonly outcome: TransportOutcome | 'released';
  readonly persistence:
    | { readonly status: 'recorded' | 'not-recorded' }
    | { readonly status: 'error'; readonly error: unknown };
}
export interface HandoffResult {
  readonly outcome: TransportOutcome | 'released' | 'not-invoked';
  readonly token?: string;
  readonly persistence?: 'recorded' | 'not-recorded';
  /** Interrupted effects may complete later; this handle never rejects and may stay pending. */
  readonly lateSettlement?: Promise<LateHandoffSettlement>;
}

function nonempty(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Expected a nonempty string');
}
function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Expected a positive safe integer');
}
function routes(value: readonly DeliveryRoute[]): void {
  if (!Array.isArray(value)) throw new TypeError('Expected routes');
  const kinds = new Set<string>();
  for (const route of value) {
    nonempty(route.kind);
    if (kinds.has(route.kind)) throw new TypeError('Duplicate route kind');
    kinds.add(route.kind);
    if (route.address === null || typeof route.address !== 'object' || Array.isArray(route.address)
      || !Object.values(route.address).every(item => typeof item === 'string')) throw new TypeError('Expected string address fields');
    if (Object.keys(route).some(key => key !== 'kind' && key !== 'address')) throw new TypeError('Unexpected route field');
  }
}
function correlation(value: DeliveryCorrelation): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.entries(value).every(([key, item]) => ['token', 'messageId', 'payloadHash'].includes(key) && typeof item === 'string'))
    throw new TypeError('Invalid correlation');
}

/** Shared by host and producer callers; an explicit delivery override always wins. */
export function deliveryLedgerLocation(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  return env.SQUARE_DELIVERY ?? path.join(homeDir, '.square', 'delivery.v3.sqlite');
}

function encodeDetails(details: Readonly<Record<string, unknown>>): string {
  const ancestors = new Set<object>();
  const encode = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || !value || ancestors.has(value)
      || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new TypeError('Expected JSON card details');
    ancestors.add(value);
    const result = Array.isArray(value) ? Array.from(value, encode)
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, encode((value as Record<string, unknown>)[key])]));
    ancestors.delete(value);
    return result;
  };
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new TypeError('Expected a card details object');
  return JSON.stringify(encode(details));
}

/** One user-owned ledger; producers supply finished text and callers choose routes. */
export class DeliveryLedger {
  private constructor(private readonly store: LedgerStore, private readonly leaseMs: number) {}
  static async open(options: { readonly location?: string; readonly clock?: () => number; readonly leaseMs?: number } = {}): Promise<DeliveryLedger> {
    const location = options.location ?? deliveryLedgerLocation();
    if (!path.isAbsolute(location)) throw new TypeError('Delivery location must be absolute');
    const leaseMs = options.leaseMs ?? 30_000;
    positive(leaseMs);
    return new DeliveryLedger(await LedgerStore.open(location, options.clock ?? Date.now), leaseMs);
  }
  close(): Promise<void> { return this.store.close(); }
  attach(input: { readonly owner: Owner; readonly expectedGeneration: string | null; readonly routes: readonly DeliveryRoute[] }): Promise<DeliverySession | false> {
    validateOwner(input.owner); routes(input.routes);
    if (input.expectedGeneration !== null) nonempty(input.expectedGeneration);
    return this.store.attach(input);
  }
  updateRoutes(input: { readonly owner: Owner; readonly generation: string; readonly routes: readonly DeliveryRoute[] }): Promise<boolean> {
    validateOwner(input.owner); nonempty(input.generation); routes(input.routes);
    return this.store.updateRoutes(input);
  }
  detach(input: { readonly owner: Owner; readonly generation: string }): Promise<boolean> { return this.lifecycle(input, 'detached'); }
  markDeleted(input: { readonly owner: Owner; readonly generation: string }): Promise<boolean> { return this.lifecycle(input, 'deleted'); }
  private lifecycle(input: { readonly owner: Owner; readonly generation: string }, state: 'detached' | 'deleted'): Promise<boolean> {
    validateOwner(input.owner); nonempty(input.generation);
    return this.store.lifecycle(input, state);
  }
  session(owner: Owner): Promise<DeliverySession | undefined> { validateOwner(owner); return this.store.session(owner); }
  sessions(): Promise<readonly DeliverySession[]> { return this.store.sessions(); }
  pending(owner: Owner, options: { readonly generation: string }): Promise<readonly DeliveryCard[]> {
    validateOwner(owner); nonempty(options.generation); return this.store.pendingCards(owner, options.generation);
  }
  handoffs(owner: Owner, options: { readonly generation: string }): Promise<readonly DeliveryAttempt[]> {
    validateOwner(owner); nonempty(options.generation); return this.store.handoffs(owner, options.generation);
  }
  post(input: { readonly owner: Owner; readonly key: string; readonly text: string; readonly details?: Readonly<Record<string, unknown>> }): Promise<PostResult> {
    validateOwner(input.owner); nonempty(input.key);
    if (typeof input.text !== 'string') throw new TypeError('Expected card text');
    return this.store.post({ ...input, details: input.details === undefined ? null : encodeDetails(input.details) });
  }
  suppress(input: { readonly owner: Owner; readonly key: string; readonly scope: 'exact' | 'prefix'; readonly expiresAt?: number }): Promise<SuppressionResult> {
    validateOwner(input.owner); nonempty(input.key);
    if (!['exact', 'prefix'].includes(input.scope) || input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) throw new TypeError('Invalid suppression');
    return this.store.suppress(input);
  }
  renewSuppression(input: { readonly owner: Owner; readonly id: string; readonly expiresAt: number }): Promise<boolean> {
    validateOwner(input.owner); nonempty(input.id);
    if (!Number.isFinite(input.expiresAt)) throw new TypeError('Expected finite suppression expiry');
    return this.store.renewSuppression(input);
  }
  releaseSuppression(input: { readonly owner: Owner; readonly id: string }): Promise<boolean> {
    validateOwner(input.owner); nonempty(input.id); return this.store.releaseSuppression(input);
  }
  cancel(input: { readonly owner: Owner; readonly generation: string }): Promise<boolean> {
    validateOwner(input.owner); nonempty(input.generation); return this.store.cancel(input);
  }
  receipts(owner: Owner, options: { readonly keys?: readonly string[]; readonly since?: number } = {}): Promise<readonly DeliveryReceipt[]> {
    validateOwner(owner);
    if (options.keys) options.keys.forEach(nonempty);
    if (options.since !== undefined && !Number.isFinite(options.since)) throw new TypeError('Expected finite receipt time');
    return this.store.receipts(owner, options);
  }
  async claimPresentation(owner: Owner, options: { readonly generation: string; readonly budgetChars: number; readonly signal?: AbortSignal }): Promise<PresentationClaim | undefined> {
    validateOwner(owner); nonempty(options.generation); positive(options.budgetChars);
    if (options.signal?.aborted) return undefined;
    const claim = await this.store.claimPresentation(owner, options.generation, options.budgetChars, this.leaseMs, options.signal);
    if (!claim) return undefined;
    const tokens = claim.attempts.map(attempt => attempt.token);
    return { ...claim,
      current: signal => this.store.current(tokens, signal ?? options.signal),
      settle: outcome => {
        if (!['presented', 'failed', 'unknown', 'released'].includes(outcome)) throw new TypeError('Invalid presentation outcome');
        return this.store.settle(tokens, outcome);
      },
    };
  }
  /** Resolve the original prepared handoff, including its stored route kind. */
  handoff(token: string): Promise<DeliveryHandoffRef | undefined> {
    nonempty(token); return this.store.handoff(token);
  }
  guardHandoff(ref: DeliveryHandoffRef): Promise<boolean> { return this.store.guardHandoff(ref); }
  acceptHandoff(ref: DeliveryHandoffRef): Promise<boolean> { return this.store.acceptHandoff(ref); }
  /** Confirms the exact existing external effect; never sends or returns text. */
  observePresentation(handoff: string | DeliveryHandoffRef, options?: { readonly requireCurrent?: boolean }): Promise<boolean> {
    if (typeof handoff === 'string') nonempty(handoff);
    return this.store.observePresentation(handoff, options);
  }
  health(owner?: Owner): Promise<DeliveryHealth> {
    if (owner !== undefined) validateOwner(owner);
    return this.store.health(owner);
  }
  /** Subscribe first; read the returned version, inspect state, then await changed(version,...). */
  observe(owner: Owner): Promise<VersionObserver<string>> {
    validateOwner(owner); return observeFileMetadata(this.store.location);
  }
  async dispatchHandoff(owner: Owner, key: string, transport: DeliveryTransport, options: {
    readonly generation: string; readonly timeoutMs: number; readonly signal?: AbortSignal;
  }): Promise<HandoffResult> {
    validateOwner(owner); nonempty(key); nonempty(options.generation); positive(options.timeoutMs);
    if (options.signal?.aborted) return { outcome: 'not-invoked' };
    nonempty(transport.kind);
    const claim = await this.store.claimHandoff(owner, key, options.generation, transport.kind, Math.max(this.leaseMs, options.timeoutMs), options.signal);
    if (!claim) return { outcome: 'not-invoked' };
    const token = claim.attempt.token;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const deadline = Date.now() + options.timeoutMs;
    let persistenceFailure: { error: unknown } | undefined;
    const persist = async <T>(operation: Promise<T>): Promise<T> => {
      try { return await operation; }
      catch (error) { persistenceFailure = { error }; throw error; }
    };
    const current = () => persist(this.store.current([token], signal, claim.route));
    const finish = async (outcome: TransportOutcome | 'released') => {
      if (!['accepted', 'presented', 'failed', 'unknown', 'not-capable', 'released'].includes(outcome)) throw new TypeError('Invalid transport outcome');
      const recorded = await this.store.settle([token], outcome === 'not-capable' ? 'released' : outcome);
      if (persistenceFailure) throw persistenceFailure.error;
      return { outcome, token, persistence: recorded ? 'recorded' as const : 'not-recorded' as const };
    };
    if (!await current() || signal.aborted || Date.now() >= deadline) return finish('released');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<'unknown'>(resolve => {
        onAbort = () => resolve('unknown');
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { resolve('unknown'); controller.abort(new Error('Delivery deadline elapsed')); }, options.timeoutMs);
      });
      // Invoke synchronously after the final fence; adapters own checks after their own awaits.
      const effect = (async () => {
        if (signal.aborted || Date.now() >= deadline) return 'released' as const;
        return transport.send(claim.card, claim.route.address, { token, deadline, signal,
          beforeSend: current,
          prepare: value => { correlation(value); return persist(this.store.prepare(token, value, signal)); },
        });
      })().catch(() => 'unknown' as const);
      const first = await Promise.race([
        effect.then(outcome => ({ outcome, interrupted: false as const })),
        interrupted.then(outcome => ({ outcome, interrupted: true as const })),
      ]);
      if (!first.interrupted) return await finish(first.outcome);
      const unknown = finish('unknown');
      // Register before awaiting persistence; even an already completed effect waits for unknown.
      const lateSettlement: Promise<LateHandoffSettlement> = unknown.then(async () => {
        const outcome = await effect;
        try {
          const result = await finish(outcome);
          return { outcome, persistence: { status: result.persistence } };
        } catch (error) { return { outcome, persistence: { status: 'error', error } }; }
      }, error => ({ outcome: 'unknown', persistence: { status: 'error', error } }));
      return { ...await unknown, lateSettlement };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}
