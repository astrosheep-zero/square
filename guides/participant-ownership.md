# Participant ownership

Membership and host attachment are different facts. Membership says a participant is in the
square; it owns their join history, read horizon and outgoing listens. Attachment says whether
an exact Body (`channel`, `session`, optional `agent`) is executing for that participant now.
A standing seat may be attached or detached. The artifact transaction is the sole custody
authority; display spelling, wake addresses and the rebuildable HOME discovery index never
grant ownership. There is no writable HostLedger ownership layer.

## Three endings

- **The participant leaves:** `Participant.done()` ends membership, removes its seat, catch
  lease and delivery deferrals, and removes outgoing listens. A later explicit `join` establishes
  a fresh generation and read horizon. No host start or resume brings a voluntary leave back.
- **The host session ends:** `detachOwnedSession` detaches only its captured Body and generation.
  It clears wake readiness, catch ownership and delivery deferrals, without landing an activity
  or changing membership, listens or the read horizon. A detached participant is **away**, still
  receives normal landed audience and accumulates unread activity, but cannot write or receive
  proactive delivery. Away has no timeout; a session that never returns simply stays away.
- **The host confirms permanent deletion:** `endOwnedSession` ends membership with a fenced
  `done`, including for a detached seat. OpenCode's `session.deleted` uses this path. Pi shutdown,
  Codex SessionEnd and Claude session end do not prove permanent deletion and therefore detach.

An explicit takeover remains `done -> join` in one transaction, whether the old seat is attached
or detached. It transfers the name to the new Body with a fresh generation; old cleanup and
recovery cannot reclaim it.

## Captured handles and restoration

`Square.at` captures an explicit Body for writes. `participant(name?)` selects a handle without
joining; `recognize()` returns only attached handles held by that exact Body. `bodySeats()` is a
read-only discovery surface for all its standing seats, including their attached/detached state.
It does not join or return done participants. See [square-api.md](square-api.md) for resource
lifetimes and selection.

- `join(name)` atomically establishes membership and its seat when absent. A same-Body reconnect
  preserves the establishing generation. On a detached seat it also reattaches, refreshes wake
  readiness from the joining resource and returns `reconnected`, with no activity, new read
  horizon or listening changes. A foreign Body gets `already_joined`; takeover must be explicit.
- `implicitJoin(name)` also reattaches a same-Body detached seat, returning `active` with a handle.
  A done participant stays done. Host start/resume restores only detached seats found through
  `bodySeats()` for that exact Body, before arming delivery. One unavailable location or failed
  reattachment does not block the others. A new or forked session has a different Body and
  restores nothing. Hosts never infer restoration from a historical departure.
- Participant mutations require both the captured generation and an attached current seat.
  Detach suspends existing handles; they cannot express, catch, listen, hold, leave or change
  deferrals until reattachment. Rejoin/takeover fences old handles permanently, even if the same
  Body later reacquires the name. Host cleanup checks Body and generation inside its transaction;
  stale, foreign, done or already-detached cleanup changes nothing.

The HOME index supplies candidate paths only. Losing it may delay restoration or delivery but
cannot transfer a seat, erase delivery evidence or consume unread activity. A wake address is
transport readiness for an attached seat, not an alternative ownership fact.

## Independent delivery deferrals

`deferDelivery`, `renewDeliveryDeferral`, and `releaseDeliveryDeferral` require the same captured,
attached current seat. Independent artifact-owned leases belong to one participant and generation,
separately from catch ownership, delivery claims and receipts. Each has a fresh opaque ID, validated
metadata match and expiry. It is not an acknowledgement intent or an activity.

Each lease's nested own-property scalar equalities combine with AND; matching active leases combine
with OR. Renewal cannot revive an expired lease. Release touches only its named live lease and
returns false for an absent/expired ID. A current owner cannot use another participant's ID.
Expiry is checked live. Detach, done, takeover and rejoin clear deferrals in the same transaction;
reattachment never revives an old lease.

Deferrals change only proactive eligibility. They preserve audience, history, unread counts and
explicit catch. A caught record is not replayed after release. Producers, observers, claims and
final send/presentation gates all require attached current custody and apply the same deferral
policy. Neither detach nor a deferral can recall an already-dispatched external message.

## Acceptance boundaries

Tests exercise foreign/stale/detached handles, same-Body restoration with unread activity intact,
voluntary leave, explicit takeover, permanent deletion, exact-body adapter lifecycle, generation
fences and delivery eligibility. Assertions belong to authoritative facts, not helper ordering or
display copy. Migration is offline and explicit; see [migration.md](migration.md).
