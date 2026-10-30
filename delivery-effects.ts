export interface EffectClaim {
  readonly token: string;
  readonly ordinal: number;
}

/** Bound to one captured item/recipient/authority/purpose, not an encoded series key. */
export interface EffectPort<C> {
  /** The caller's existing atomic claim operation. Undefined means no custody acquired. */
  claim(signal?: AbortSignal): Promise<EffectClaim | undefined>;
  /** Pre-effect policy only. Rejection means unverifiable/not current. */
  current(signal?: AbortSignal): Promise<boolean>;
  /**
   * No request signal: persistence has its own bounded lifetime. For presentation,
   * `presented` MUST complete the attempt and record ALL captured full-consumption
   * receipts in ONE atomic transaction (rollback both on error). `clipped`, `failed`,
   * `unknown` and `released` complete the attempt without full-consumption receipts.
   * No post-effect currentness/deferral/cancellation veto; captured authority still fences.
   */
  settle(claim: EffectClaim, completion: C): Promise<boolean>;
}

export type Persistence =
  | { readonly status: 'recorded' }
  | { readonly status: 'not-recorded' }
  | { readonly status: 'error'; readonly error: unknown };
export interface Settlement<C> {
  readonly completion: C;
  readonly persistence: Persistence;
}

async function settle<C>(port: EffectPort<C>, claim: EffectClaim, completion: C): Promise<Settlement<C>> {
  try {
    return { completion, persistence: { status: await port.settle(claim, completion) ? 'recorded' : 'not-recorded' } };
  } catch (error) { return { completion, persistence: { status: 'error', error } }; }
}
async function current<C>(port: EffectPort<C>, signal?: AbortSignal): Promise<boolean> {
  try { return await port.current(signal); } catch { return false; }
}

export interface DispatchOutcome {
  readonly outcome: 'accepted' | 'failed' | 'unknown' | 'not-capable';
  readonly data?: unknown;
}
export type DispatchCompletion =
  | { readonly outcome: 'accepted' | 'failed' | 'unknown'; readonly reason: 'returned'; readonly data?: unknown }
  | { readonly outcome: 'unknown'; readonly reason: 'threw'; readonly error: unknown }
  | { readonly outcome: 'unknown'; readonly reason: 'timeout' }
  | { readonly outcome: 'released'; readonly reason: 'not-current'; readonly phase: 'initial' | 'final' }
  | { readonly outcome: 'released'; readonly reason: 'not-capable'; readonly data?: unknown }
  | { readonly outcome: 'released'; readonly reason: 'cancelled' };
export interface DispatchContext {
  readonly claim: EffectClaim;
  readonly timeoutMs: number;
  readonly deadline: number;
  readonly signal?: AbortSignal;
  /** Policy only. Sender MUST recheck deadline/cancellation after this await before I/O. */
  beforeSend(): Promise<boolean>;
}
export interface DispatchReport {
  readonly observation:
    | { readonly kind: 'not-invoked' }
    | { readonly kind: 'returned'; readonly result: DispatchOutcome }
    | { readonly kind: 'threw'; readonly error: unknown }
    | { readonly kind: 'timeout' };
  readonly settlement?: Settlement<DispatchCompletion>;
}

/** Timer bounds the external attempt only, not claim/currentness/persistence. No automatic retry. */
export async function dispatchEffect(
  port: EffectPort<DispatchCompletion>,
  send: (context: DispatchContext) => Promise<DispatchOutcome>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<DispatchReport> {
  const notInvoked: DispatchReport['observation'] = { kind: 'not-invoked' };
  if (options.signal?.aborted) return { observation: notInvoked };
  const claim = await port.claim(options.signal);
  if (claim === undefined) return { observation: notInvoked };
  if (!await current(port, options.signal)) return { observation: notInvoked,
    settlement: await settle(port, claim, { outcome: 'released', reason: 'not-current', phase: 'initial' }) };
  if (options.signal?.aborted) return { observation: notInvoked,
    settlement: await settle(port, claim, { outcome: 'released', reason: 'cancelled' }) };

  let denied = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + options.timeoutMs;
  const timeout = new Promise<Exclude<DispatchReport['observation'], { kind: 'not-invoked' }>>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), options.timeoutMs);
  });
  let observation: Exclude<DispatchReport['observation'], { kind: 'not-invoked' }>;
  let completion: DispatchCompletion;
  try {
    observation = await Promise.race([timeout, (async (): Promise<Exclude<DispatchReport['observation'], { kind: 'not-invoked' }>> => {
      try {
        return { kind: 'returned', result: await send({ claim, deadline, ...options,
          beforeSend: async () => {
            const allowed = await current(port, options.signal);
            if (!allowed) denied = true;
            return allowed;
          },
        }) };
      } catch (error) { return { kind: 'threw', error }; }
    })()]);
    // Freeze before persistence. Late policy results/sender completions cannot rewrite it.
    completion = observation.kind === 'timeout' ? { outcome: 'unknown', reason: 'timeout' }
      : denied ? { outcome: 'released', reason: 'not-current', phase: 'final' }
      : observation.kind === 'threw' ? { outcome: 'unknown', reason: 'threw', error: observation.error }
      : observation.result.outcome === 'not-capable'
        ? { outcome: 'released', reason: 'not-capable', data: observation.result.data }
        : { outcome: observation.result.outcome, reason: 'returned', data: observation.result.data };
  } finally { if (timer !== undefined) clearTimeout(timer); }
  return { observation, settlement: await settle(port, claim, completion) };
}

export type PresentationCompletion =
  | { readonly outcome: 'presented' | 'clipped'; readonly reason: 'returned' }
  | { readonly outcome: 'failed' | 'unknown'; readonly reason: 'threw'; readonly error: unknown }
  | { readonly outcome: 'released'; readonly reason: 'not-current' | 'cancelled' | 'unused' };
export interface PresentationWork<P> {
  readonly payload: P;
  readonly coverage: 'full' | 'clipped';
  readonly port: EffectPort<PresentationCompletion>;
}
const preparedBrand: unique symbol = Symbol('prepared presentation');
export interface PreparedPresentation<P> {
  readonly [preparedBrand]: true;
  readonly payload: P;
  eligible(signal?: AbortSignal): Promise<boolean>;
  release(): Promise<Settlement<PresentationCompletion>>;
}
export interface PresentationControl {
  readonly signal?: AbortSignal;
  /** Default unknown; throwing or invalid classifiers also stay unknown. */
  readonly classifyError?: (error: unknown) => 'failed' | 'unknown';
}
export interface PresentationReport<P, R> {
  readonly observation:
    | { readonly kind: 'not-invoked' }
    | { readonly kind: 'returned'; readonly value: R }
    | { readonly kind: 'threw'; readonly error: unknown; readonly outcome: 'failed' | 'unknown' };
  readonly settlements: readonly {
    readonly prepared: PreparedPresentation<P>;
    readonly result: Settlement<PresentationCompletion>;
  }[];
}

interface Custody {
  owned: boolean;
  readonly eligible: (signal?: AbortSignal) => Promise<boolean>;
  readonly coverage: 'full' | 'clipped';
  readonly done: Promise<Settlement<PresentationCompletion>>;
  finish(completion: PresentationCompletion): void;
}
const custody = new WeakMap<object, Custody>();

export async function preparePresentation<P>(work: PresentationWork<P>, control?: { readonly signal?: AbortSignal }): Promise<PreparedPresentation<P> | undefined> {
  if (control?.signal?.aborted) return undefined;
  const claim = await work.port.claim(control?.signal);
  if (claim === undefined) return undefined;
  let resolve!: (result: Settlement<PresentationCompletion>) => void;
  let decided = false;
  const state: Custody = {
    owned: false, coverage: work.coverage,
    eligible: signal => signal?.aborted ? Promise.resolve(false) : current(work.port, signal),
    done: new Promise(res => { resolve = res; }),
    finish(completion) {
      if (decided) return;
      decided = true;
      // Defer callbacks: every included handle is marked before any settlement starts.
      void Promise.resolve().then(() => settle(work.port, claim, completion)).then(resolve);
    },
  };
  const prepared: PreparedPresentation<P> = Object.freeze({
    [preparedBrand]: true as const,
    payload: work.payload,
    eligible: (signal?: AbortSignal) => state.owned ? Promise.resolve(false) : state.eligible(signal),
    release() {
      if (!state.owned) {
        state.owned = true;
        state.finish({ outcome: 'released', reason: 'unused' });
      }
      return state.done;
    },
  });
  custody.set(prepared, state);
  return prepared;
}

export function presentPrepared<P, R>(prepared: PreparedPresentation<P>, sink: (payload: P) => R | Promise<R>, control?: PresentationControl): Promise<PresentationReport<P, R>> {
  return presentPreparedBatch([prepared], eligible => ({ payload: prepared.payload, included: eligible }), sink, control);
}

/** Takes all local custody synchronously, then owns eligibility/effect/settlement/cleanup. */
export async function presentPreparedBatch<P, B, R>(
  prepared: readonly PreparedPresentation<P>[],
  render: (eligible: readonly PreparedPresentation<P>[]) => { readonly payload: B; readonly included: readonly PreparedPresentation<P>[] },
  sink: (payload: B) => R | Promise<R>,
  control: PresentationControl = {},
): Promise<PresentationReport<P, R>> {
  const handles = [...prepared];
  const states = handles.map(handle => custody.get(handle));
  if (new Set(handles).size !== handles.length || states.some(state => state === undefined || state.owned)) {
    await Promise.all([...new Set(handles)].filter(handle => custody.has(handle) && !custody.get(handle)!.owned).map(handle => handle.release()));
    throw new TypeError('Presentation requires unique, unused prepared custody.');
  }
  const owned = states as Custody[];
  for (const state of owned) state.owned = true;
  let observation: PresentationReport<P, R>['observation'] = { kind: 'not-invoked' };
  try {
    const eligible: PreparedPresentation<P>[] = [];
    for (const [index, state] of owned.entries()) {
      if (await state.eligible(control.signal)) eligible.push(handles[index]!);
      else state.finish({ outcome: 'released', reason: control.signal?.aborted ? 'cancelled' : 'not-current' });
    }
    const rendered = render(Object.freeze(eligible));
    const included = [...rendered.included];
    if (new Set(included).size !== included.length || included.some(handle => !eligible.includes(handle)))
      throw new TypeError('Included presentations must be a unique subset of eligible custody.');
    if (included.length > 0 && !control.signal?.aborted) {
      let completion: PresentationCompletion;
      try {
        const value = await sink(rendered.payload);
        observation = { kind: 'returned', value };
        completion = { outcome: 'presented', reason: 'returned' };
      } catch (error) {
        let outcome: 'failed' | 'unknown' = 'unknown';
        try { if (control.classifyError?.(error) === 'failed') outcome = 'failed'; } catch { /* conservative */ }
        observation = { kind: 'threw', error, outcome };
        completion = { outcome, reason: 'threw', error };
      }
      for (const handle of included) {
        const state = custody.get(handle)!;
        state.finish(completion.outcome === 'presented'
          ? { outcome: state.coverage === 'full' ? 'presented' : 'clipped', reason: 'returned' } : completion);
      }
    }
  } finally {
    for (const state of owned) state.finish({ outcome: 'released', reason: control.signal?.aborted ? 'cancelled' : 'unused' });
    await Promise.all(owned.map(state => state.done));
  }
  return { observation, settlements: await Promise.all(handles.map(async (handle, index) => ({ prepared: handle, result: await owned[index]!.done }))) };
}
