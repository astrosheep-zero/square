# Delivery custody primitives

`@astrosheep/square/delivery` provides storage-independent attempt transitions, suppression predicates,
and four bound effect functions: `dispatchEffect`, `preparePresentation`, `presentPrepared`, and
`presentPreparedBatch`. It does not open a square, interpret identities, own transactions, or schedule
retries. Square's actual dispatch, single presentation and boundary batch adapters compose these same
lifecycles; its SQLite adapter uses the attempt transitions with existing tables. Ownership, membership,
cancellation and delivery-deferral policy remain in the bound application capability.

## Bind a series inside a transaction

`AttemptRows<D>` is a capability for **one logical item / recipient / authority / purpose series**.
The caller chooses those coordinates, including arbitrary opaque strings, and binds the store to them.
No Square name, seat, generation, activity-id codec or composite-key format is required.

- `list()` returns that series newest ordinal first.
- `byToken(token)` returns only a matching attempt in that series.
- `insert(attempt)` and `replace(attempt)` write within the caller's current transaction.
- Replacements preserve purpose, token, ordinal and the caller's external series coordinates.

The caller guarantees isolation against competing claims, token uniqueness within its token lookup
scope, atomic commit/rollback, and durable storage where needed. Run each operation and its reads and
writes inside that boundary; an asynchronous read followed later by an unguarded write is not custody.
Stores must not retain mutable references that allow a caller to change durable rows without a write.
`D` belongs entirely to the caller. The primitive does not merge, serialize or interpret it.

```ts
import { claimAttempt, prepareAttempt, settleAttempt, type AttemptRows } from '@astrosheep/square/delivery';

type Payload = { route?: string; nativeToken?: string; ack?: string };
// Supplied by the application, already scoped and transaction-bound:
declare const rows: AttemptRows<Payload>;

const claim = claimAttempt(rows, {
  purpose: 'dispatch', token: 'application-generated-unique-token',
  at: 1000, leaseMs: 30_000, data: { route: 'opaque endpoint' },
});
if (claim.status === 'acquired') {
  prepareAttempt(rows, { token: claim.token, data: { route: 'opaque endpoint', nativeToken: 'correlation' } });
}
// In a later transaction, only after external proof of acceptance:
settleAttempt(rows, {
  token: 'application-generated-unique-token', outcome: 'accepted', at: 1100,
  data: { route: 'opaque endpoint', nativeToken: 'correlation', ack: 'external proof' },
});
```

The example shows only transaction-scoped transitions. Commit a successful claim before external I/O;
settle its exact token in a new transaction after observing the result. The bound effect capability
below connects those operations without introducing a generic transaction runtime. Authority fencing,
currentness policy and the meaning of external proof remain the application's responsibility.
An `accepted` dispatch is not proof of presentation or consumption. Only the responsible presentation
boundary may assert `presented`; consuming an item is a separate application operation.

## Transitions

An `Attempt<D>` has `purpose: 'dispatch' | 'presentation'`, `token`, zero-based `ordinal`, `outcome`,
finite `at`, optional `expiresAt`, and `data`.

- `claimAttempt` first returns terminal evidence: dispatch `accepted`/`unknown`, presentation
  `presented`/`unknown`. Otherwise a live `dispatching` attempt is `busy`; missing expiry is live.
- At exact expiry or later, an interrupted `dispatching` attempt becomes `unknown`, keeps its original
  payload, loses expiry, and returns `terminal` with `interrupted: true`. There is no new attempt and
  **no automatic replay of uncertainty**. Square maps that flag to its interruption diagnostic.
- With neither terminal nor dispatching evidence, claim inserts `dispatching` at the next ordinal.
  Failed/released attempts can therefore be retried. Purpose-specific terminal meanings are not
  inferred from other completion labels.
- `prepareAttempt` replaces only the data of the exact `dispatching` token. Pass the complete merged
  payload. It returns false for an absent or no-longer-dispatching token. Callers that already know
  the payload is unchanged may skip the replacement; core performs no JSON equality checks.
- `settleAttempt` allows `dispatching` to any defined completion, and late `unknown` to `accepted`.
  It clears expiry and sets time/outcome/data. `accepted` to `accepted` returns true **without any
  write or payload/time mutation**. All other transitions return false, including `unknown` to
  `presented`. Missing or foreign tokens cannot settle another series.

Invalid purpose/completion/token/time, non-positive or unsafe lease durations, non-finite expiry, and
unsafe next ordinals reject before mutation with `TypeError` or `RangeError`, not `SquareError`.
The caller supplies valid stored attempts and consistently scoped, ordered rows.

## Suppression without payloads

`presentationBlocksDispatch(attempts, now)` and `automaticDispatchEligible(attempts, now)` accept only
`purpose`, `outcome`, and optional `expiresAt`; no dummy payload or identity is needed. These predicates
may see both purposes for the same logical delivery.

Presentation `presented`, `clipped`, `unknown`, or live `dispatching` blocks dispatch. Expired
presentation dispatching alone does not. Automatic dispatch additionally requires no dispatch
`accepted`, `unknown`, or `dispatching`; even expired dispatch custody blocks automatic replay.
These are preselection predicates, not substitutes for a transactional claim or application gates.


## Bound effects: one captured capability, four functions

`EffectPort<C>` is bound by the caller to **one captured work item / recipient / authority / purpose**.
It exposes only:

- `claim(signal?)`: the application's existing atomic claim, returning `{ token, ordinal }` or
  `undefined` when busy, terminal, stale or deferred. The runner does not claim the attempt twice.
- `current(signal?)`: pre-effect policy; a rejected check is unverifiable and treated as false.
- `settle(claim, completion)`: one captured settlement operation, with no request signal. Return true
  only when it commits, false when not recorded (not necessarily stale), or throw on persistence error.

The application owns tokens, leases, semantic timestamps, authority, proof/diagnostic payloads and
resource lifetimes. There is no public transaction type, series-key codec or extra persisted lifecycle.
`Settlement<C>` keeps the selected completion separate from persistence: `recorded`, `not-recorded`,
or `error` with the original error. Observations are never erased by persistence refusal/error.

### Dispatch

```ts
import { dispatchEffect, type EffectPort, type DispatchCompletion } from '@astrosheep/square/delivery';

declare const port: EffectPort<DispatchCompletion>; // bound claim/current/settle
// A sender must check its absolute deadline/cancellation immediately before external mutation.
const report = await dispatchEffect(port, async context => {
  if (!await context.beforeSend()) return { outcome: 'not-capable' };
  if (context.signal?.aborted || Date.now() >= context.deadline) return { outcome: 'unknown' };
  // Call the application's transport here, passing the remaining budget and captured claim.
  return { outcome: 'accepted', data: { proof: 'application acknowledgement' } };
}, { timeoutMs: 5000 });
```

`dispatchEffect` owns claim → initial currentness → send → settlement. Cancellation suppresses
pre-effect work. It starts its timer immediately before invoking the sender, not during claim,
initial policy reads or persistence. Exactly one returned/thrown/timeout decision is frozen before
settlement. A sender exception defaults to `unknown`, not failed; returned `not-capable` releases
custody. A denied final gate releases with `not-current / final` under the sender's obligation to
obey it. No automatic retry occurs.

`beforeSend()` is **policy currentness, not an elapsed-budget gate**. A stalled policy check may
return true after the outer timeout. The sender must recheck `deadline` and `signal` after that await
and immediately before I/O; true does not authorize a late send. Outer timeout stays unknown even
when no I/O is known to have started. Late gates and late promise results cannot rewrite the frozen
settlement. Separately correlated native proof may still use the attempt transition's permitted late
unknown → accepted path; the timed-out runner does not reconcile itself.

### Prepared presentation

`preparePresentation({ payload, coverage, port }, { signal? })` acquires custody without running a
sink. A returned `PreparedPresentation<P>` exposes `payload`, pre-effect `eligible(signal?)`, and
promise-cached `release()` for abandonment. It is a local one-shot capability, not a durable row and
not a public success writer.

`presentPrepared(handle, sink, control?)` specializes the batch lifecycle to one item.
`presentPreparedBatch(handles, render, sink, control?)` takes all supplied custody before its first
await. It rejects duplicate, foreign or used handles before any effect, checks eligibility, then calls
synchronous side-effect-free `render(eligible)` returning `{ payload, included }`. Included handles
must be a unique exact subset of those eligible handles; invalid rendering releases custody and
rejects without presentation evidence. No included items means no sink call.

Cancellation is checked immediately before the one sink invocation. There is **no presentation timer**
and no post-effect cancellation, deferral or currentness veto. The runner awaits the sink and marks
**all included handles** effect-observed before starting asynchronous settlements. Full coverage
settles `presented`; clipped coverage settles `clipped`. A thrown sink defaults to `unknown`;
`classifyError` may explicitly return `failed` (classifier failure stays unknown). Unused handles are
released, all sibling settlements and cleanup drain even on persistence failure, and later cleanup
cannot overwrite success or uncertainty.

### Mandatory atomic full-consumption settlement

The presentation binding's single `settle` operation must enforce:

| Completion | Atomic persistence |
| --- | --- |
| `presented` | Complete the captured attempt **and all captured full-consumption receipts in the same transaction**. Return true only when the combined operation commits. |
| `clipped` | Complete the attempt; no full-consumption receipt. |
| `failed`, `unknown`, `released` | Complete the attempt; no success consumption receipt. |

If receipt writing throws, both receipt writes and attempt completion must roll back. Do not reselect
items or split `complete` and `recordConsumed` into separately awaited callbacks. Captured ownership
still fences settlement; request cancellation and new delivery deferrals do not. TypeScript cannot
supply isolation for a caller, so this is a mandatory port contract, tested in Square's real transaction.

Presentation reports distinguish observed sink behavior from durable persistence. A returned sink
with `not-recorded` or `error` still returned successfully; that alone proves only the supplied sink's
documented effect, not model consumption or human display. Square explicitly classifies its existing
rejected sinks as failed and rethrows the original exception after draining. Its single result stays
`{ presented: true, activity }` only on recorded success, false on ownership refusal; unexpected
success-settlement errors propagate. Batch returns its original sink value after all settlements,
with the same error propagation. No schema, storage format or public Square result changes are needed.
