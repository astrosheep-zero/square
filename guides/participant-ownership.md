# Participant ownership

A participant has one current artifact-owned seat: its normalized participant name, exact Body
(`channel`, `session`, optional `agent`), establishing join generation, and optional wake address.
Display spelling and discovery-index entries never grant write authority. The artifact transaction
is the sole custody authority; there is no writable HostLedger ownership layer.

## Captured handles and lifecycle

`Square.at` captures an explicit Body for writes. `participant(name?)` selects a handle without
joining; `recognize()` returns current handles held by that exact Body. A name alone is not
permission to mutate. Read-only archive operations need no Body. See [square-api.md](square-api.md)
for the public resource lifetime and selection contract.

- `join(name)` atomically lands the join and stores its seat. Same-body reconnect preserves its
  generation and may refresh the wake address. A foreign Body receives `already_joined` rather
  than taking ownership implicitly.
- `join(name, {takeover:true})` explicitly completes the captured old seat and establishes a new
  one with `done -> join` in one transaction. Its compare-and-set generation prevents a concurrent
  takeover from being silently replaced.
- Participant mutations carry the captured seat into the transaction. The gate checks both Body
  and generation, including when the same Body later reacquires the name. An old handle never
  becomes fresh because a name matches again.
- `done` retires only the current captured seat, catch lease and delivery deferrals. A later join
  establishes a fresh generation. Completed coordinates retained for exact-body diagnostics are
  not current write authority. Owner-session cleanup uses the same fence and cannot complete a
  replacement seat.
- Stdio retains the selected Participant in a connection-local reference. Each operation uses that
  captured handle instead of reselecting authority by name. Rejoin/takeover therefore fences old
  remote handles just as it does local SDK handles.

The HOME discovery index is rebuildable candidate-path data. Losing it can delay discovery but
cannot transfer a seat or erase delivery evidence. A wake address is only transport readiness for
an existing seat, not an alternative ownership fact.

## Independent delivery deferrals

`deferDelivery`, `renewDeliveryDeferral`, and `releaseDeliveryDeferral` require that same captured
current seat. Deferrals live in the artifact, keyed by normalized participant, generation and fresh
UUID, independently of the single catch lease and of delivery claims/receipts. A lease contains
only its validated metadata match and expiry; it is not an acknowledgement intent or an activity.

Each lease's nested own-property scalar equalities combine with AND; matching active leases combine
with OR. Renewal cannot revive an expired lease. Release touches only its named live lease, and
returns false for an absent/expired ID. A current owner cannot use another participant's ID.
Expired rows may be pruned during owner writes; read/claim eligibility always checks expiry and
the current generation. Done/takeover/rejoin remove deferrals in the same transaction, and stale
rows can never become active for a new generation.

Deferrals change only proactive eligibility. They preserve audience, history, unread counts and
explicit catch. An explicit catch consumes normally and prevents later replay after release.
All proactive paths recheck the same typed policy at claim and final send/presentation boundaries.
An already-dispatched external message cannot be recalled by acquiring a lease.

## Acceptance boundaries

Tests exercise foreign and stale handles, same-body reconnection/rejoin, explicit takeover,
transaction-scoped generation fences, independent leases, precise expiry, explicit catch and
stdio parity. Assertions belong to the authoritative facts, not helper call ordering or display
copy. Migration of old owner/route facts is offline and explicit; see [migration.md](migration.md).
