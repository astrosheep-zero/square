# Participant ownership

Membership and host attachment are different facts. Membership says a participant is in the
square; it owns their join history, read horizon and outgoing listens. Attachment says whether
an exact opaque owner is executing for that participant now.
A standing seat may be attached or detached. The artifact transaction is the sole custody
authority; display spelling, wake addresses and the rebuildable HOME discovery index never
grant ownership. There is no writable HostLedger ownership layer.

Owners are opaque non-secret strings, not harness coordinates or authentication. Harness adapters
encode their own identity; terminal owners use `user:<OS user>@<host>` and are never automatically
detached or ended by a harness. A seat's optional wake route is self-contained transport readiness,
not an owner or an alternative custody fact.

## Three endings

- **The participant leaves:** `Participant.done()` ends membership, removes its seat, catch
  lease and delivery deferrals, and removes outgoing listens. A later explicit `join` establishes
  a fresh generation and read horizon. No host start or resume brings a voluntary leave back.
- **The host session ends:** `detach(name, {owner, generation})` detaches only that exact owner and
  join generation. It clears wake readiness, catch ownership and delivery deferrals, without landing
  an activity or changing membership, listens or the read horizon. A detached participant is
  **away**, still receives normal landed audience and accumulates unread activity, but cannot write
  or receive proactive delivery. Away has no timeout; a session that never returns simply stays away.
- **The host confirms permanent deletion:** `endHeld(name, {owner, generation})` ends membership
  with a fenced `done`, including for a detached seat. OpenCode's `session.deleted` uses this path.
  Pi shutdown, Codex SessionEnd and Claude session end do not prove permanent deletion and therefore
  detach.

An explicit takeover remains `done -> join` in one transaction, whether the old seat is attached
or detached. It transfers the name to the new owner with a fresh generation; old cleanup and
recovery cannot reclaim it.

## Captured handles and restoration

A `Square` captures no participant identity. `participant(name, {owner})` selects an attached,
standing seat held by that exact owner without joining; never-joined, done, foreign and detached
seats refuse with join recovery facts, not ghost handles. `seatsOf(owner)` is a read-only discovery
surface for the owner's standing seats as `{name, generation, attachment}`. It includes attached and
detached seats, but does not join or return done participants. See [square-api.md](square-api.md)
for resource lifetimes and adapter selection.

- `join(name, {owner, wakeAddress?})` atomically establishes membership and its seat when absent.
  A same-owner reconnect preserves the establishing generation. On a detached seat it also
  reattaches, using the operation's supplied wake address, and returns `reconnected`, with no
  activity, new read horizon or listening changes. A foreign owner gets `already_joined`; takeover
  must be explicit.
- `reattach(name, {owner, wakeAddress?})` returns a handle for an exact-owner standing seat, or
  `null` for absent, foreign or done custody; it never creates membership. A foreign takeover racing
  the transaction can instead refuse. It can also refresh an attached seat's wake address subject to
  native-route preference. Host start/resume restores only detached seats found through
  `seatsOf(owner)` before arming delivery. One unavailable location or
  failed reattachment does not block the others. A new or forked session has a different owner and
  restores nothing. Hosts never infer restoration from a historical departure.
- Participant mutations require both the captured generation and an attached current seat.
  Detach suspends existing handles; they cannot express, catch, listen, hold, leave or change
  deferrals until reattachment. Rejoin/takeover fences old handles permanently, even if the same
  owner later reacquires the name. Host cleanup checks owner and generation inside its transaction;
  stale, foreign, done or already-detached detach changes nothing. Host `cancelDeliveries` also
  requires the captured owner/generation and an attached current seat; it does not consume activity.

The HOME index supplies candidate paths only. Successful file-backed joins and non-null
reattachments attempt best-effort publication; opening or expressing does not publish. Losing the
index may delay restoration or delivery but cannot transfer a seat, erase delivery evidence or
consume unread activity. A wake address is transport readiness for an attached seat, not an
alternative ownership fact.

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

Tests exercise foreign/stale/detached handles, same-owner restoration with unread activity intact,
voluntary leave, explicit takeover, permanent deletion, exact-owner adapter lifecycle, generation
fences and delivery eligibility. Assertions belong to authoritative facts, not helper ordering or
display copy. Migration is offline and explicit; see [migration.md](migration.md).
