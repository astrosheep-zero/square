# Transaction-local receive and consumption

`@astrosheep/square/receive` admits items and their settled audience, selects
received heads without consumption, and records sparse first-write-wins receipts.
It has no runtime dependencies, Square membership, SQLite or transport requirement.
For computing an audience before admission, see [attention](attention-primitive.md).

```ts
import { receive, consumeReceived } from '@astrosheep/square/receive';

// Both callbacks belong to your storage implementation, not this package.
store.transaction(tx => receive(tx, {
  item: { key: 'opaque:west/7?hello', data: { text: 'Hello' } },
  audience: [{ recipient: 'east:bob', via: 'link' }],
}));
const page = store.transaction(tx => consumeReceived(tx, 'east:bob', {
  kind: 'page', query: { sender: 'west:alice' }, limit: 10,
}, Date.now()));
// { items: [{ key, data, via }], newlyConsumed, remaining }
```

`store` and `tx` above are caller-owned storage, not exports. Implement
`ReceiveRead<K,D,V,Q>` / `ReceiveWrite<K,D,V,Q>` structurally; each function only
requires the `Pick` of methods it uses. `K extends string | number` is an opaque
equality identity: no ordering, parsing, numeric sequence, or `act/N` convention
is imposed. The storage defines head order and query semantics. `D`, route `V`,
and query `Q` are caller data. Recipients are strings; the caller owns canonical
identity and eligibility. Item and address keys must be unique in storage.

## Capabilities and ownership

- `insertItem({key,data})` and `insertAddress(key,{recipient,via},order)` admit an
  item and its audience in supplied order. `receive` permits an empty audience.
  Supply unique recipient keys; duplicate items/addresses must throw, never
  overwrite or silently deduplicate. Roll back the whole admission on failure.
- `heads(recipient,query,{unconsumed,limit})` applies the query and consumption
  predicate **before** limiting, returning ordered `{key,via}` heads.
  `addressed(recipient,key)` ignores receipt state, but checks addressedness.
- `load(keys)` hydrates the selected keys once as a `ReadonlyMap<K,D>`.
  Missing keys are errors; an explicitly stored `undefined` value is not missing.
  `count(recipient,query,unconsumed)` counts the same selection without a limit.
- `receipt({recipient,item})` reads `{at}` or `undefined`.
  `insertReceipt(ref,at)` returns true only for a new coordinate and preserves the
  first timestamp. The identity is `(recipient,item)`, not a cursor or generation.

All functions are synchronous. Supply capabilities from **one isolated,
caller-owned transaction**, with storage uniqueness constraints and rollback on
any thrown error, including failures during hydration, receipt insertion or the
final count. No capability or selected page should escape that transaction for
later consumption. The leaf does not start, commit, retry or emulate transactions.
Its atomicity depends on this caller obligation.

## Selection and receipts

`selectReceivedHeads(tx,recipient,selection)` never hydrates or writes. A page is
`{kind:'page',query,limit}` and always selects unconsumed heads; `limit` must be a
positive safe integer, with no policy maximum. An exact selection is
`{kind:'exact',key,remainingQuery}` and remains repeatable after consumption.

`consumeReceived` selects inside the supplied transaction, hydrates all selected
keys before any receipt insertion, preserves head order, records the captured
coordinates and counts matching unconsumed items. Exact remaining uses
`remainingQuery`; page remaining uses `query`. Repeating exact consumption returns
the same item with `newlyConsumed: 0`, not a second receipt.

`recordConsumed(tx,refs,at)` only needs `insertReceipt`. It records captured
coordinates without reselecting, loading or checking eligibility. Duplicate refs
are idempotent through storage and cannot change the first timestamp. Timestamps
must be finite numbers (negative/fractional timestamps are allowed). Nonnumber
limits/timestamps throw `TypeError`; out-of-range numbers throw `RangeError`.
`ReceiveError` exposes `code: 'not_addressed' | 'missing_item'` and the opaque `key`.
Storage errors propagate unchanged; they still require caller rollback.

This is not a remote message protocol, replay envelope, permission system,
ordering service, billing ledger or exactly-once external effect guarantee.
Delivery attempts and presentation are separate from consumption. The
[symmetric domains example](symmetric-domains.md) composes all three public
primitive entrypoints without constructing Square.

## Square composition

Square uses these functions for production landing, catch and `markSeen` (including explicit
`Participant.ack`) against its existing activity, audience and receipt tables. `Participant.pending`
uses the same addressed/unconsumed relation without writing receipts; its shared exact-ID, sender,
metadata, search and cursor filters are applied by storage before the page limit. Numeric activity indexes stay
internal keys; the primitive does not know Square IDs. Square retains validation,
limits, filtering, perception, ownership, leases, hints and error mapping. The
empty-catch read probe does not hydrate or acquire a writer; a nonempty probe is
reselected inside the writer. Ordinary catch sees historical receipt holes,
including before rejoin; proactive pending still starts after the latest join.
The artifact schema/format and receipt identity are unchanged. See the
[Square API](square-api.md) for product operations.
