# Delivery custody primitives

`@astrosheep/square/delivery` provides synchronous, storage-independent attempt transitions and
suppression predicates. It does not open a square, interpret identities, dispatch effects, consume
activity, or schedule retries. Square's SQLite adapter uses this same state machine with its existing
tables; ownership, membership, cancellation and delivery-deferral gates stay outside it.

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

The example omits effect execution deliberately. Commit a successful claim before doing external I/O;
settle its exact token in a new transaction after observing the result. Authority fencing, final
eligibility checks, timeouts and the meaning of external proof remain the application's responsibility.
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
