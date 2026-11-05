# Delivery ledger

`@astrosheep/square/delivery-ledger` exports `DeliveryLedger` and its types, also available from the
package root. The per-user ledger defaults to `~/.square/delivery.v3.sqlite` and stores producer-neutral,
finished text cards, session attachment, routes, attempts and receipts. Producers own content and
recipient selection; adapters own transport behavior. Routes contain only `{kind, address}`.
A card may also carry producer-neutral presentation `details`:
`{kind: 'presentation', origin, author?, ref?, badge?, body}`. `text` remains the bounded model-facing
card; `body` holds the full Markdown for display. Receivers validate these details and render them
without opening producer storage. Cards without valid presentation details remain plain text.

Posting is idempotent by owner and key. Producer-push handoff and receiver-pull presentation have
separate attempt tracks, with cross-track exclusion based on ledger attempt state. Accepted or unknown
handoff does not establish presentation; uncertain effects must not be blindly replayed. Presentation
receipts record only the cards confirmed by the receiving boundary. A receipt means observed at that
boundary, not model comprehension. An observer may not detect a later plugin removing a card.
Receipt retention is finite: once evidence expires, Square retains unproved local unread until perceive
or ACK, rather than inventing consumption or reinserting an uncertain old card.

The ledger is an outbox. Accepted and unknown attempts drop card text and details in the same
transaction, retaining only custody so an exact late observation can still write a receipt. A presented
presentation attempt deletes its card and attempts once no attempt is dispatching; a permanent exact
suppression prevents reposting the key. Unconfirmed accepted/unknown custody expires only after
30 days from its latest settlement. Failed and released attempts keep content for retry. Receipts and
permanent suppressions expire in bounded batches after 30 days. Deleted sessions lose cards, attempts
and suppressions; sessions detached longer than 30 days lose cards and attempts. Session rows remain:
a deleted row is the authority for producer reconciliation and cannot be registered again.

Square folds receipts lazily into its own read state only for full activity cards; a shortened activity
card points to `square_perceive` and cannot consume the full activity. Perceive permanently suppresses the
corresponding ledger card where possible. Cancellation suppresses outstanding work without claiming it was seen and cannot
recall an external send already past its final check. Producers can call
`ledger.suppress({owner, key, scope: 'exact' | 'prefix', expiresAt?})` to suppress one key or a key
prefix. Omit `expiresAt` for permanent suppression within ledger retention, or supply an expiry for
temporary suppression. This does not consume Square activity; producer-owned exact ACK is described
in [square-api.md](square-api.md). The ledger does not match producer metadata.

Square posting, the Codex Stop watcher and OpenCode receivers use `DeliveryLedger.close()` to retire
ordinary work immediately. The ledger alone retains its original connection while an already-invoked
handoff has pending late evidence, including when initial unknown persistence rejects before a result
can be returned. `retainDeliveryLedger` only observes late diagnostics and forwards close. Timeout or
cancellation returns after independently bounded settlement; the physical connection closes after the
last captured effect settles. It holds no open SQLite transaction while waiting for the effect and
grants no further send authority after retirement. An effect that never settles may retain an idle
connection until process exit. Late persistence failures produce redacted diagnostics rather than
reopening the ledger or retrying the effect. Pi presentation and Claude's independent exact-reference
confirmation callbacks retain their existing lifetimes.

`DeliveryLedger.open({signal})` bounds opening, validation and configuration only; it never binds that
signal to later operations. Ordinary ledger methods accept a trailing optional `AbortSignal` (claims
and handoff dispatch keep their existing options signal). Cancellation while queued rejects promptly
and prevents that operation from executing later. Close cancels ordinary acquisition and queued waits.
Host entry points pass one shared budget through their storage steps; watchers pass their lifetime
signal. `dispatchHandoff` starts its own deadline before claim acquisition and the initial currentness
check. Interruption before transport invocation releases the claim; after invocation it records unknown
custody and preserves late evidence. Claim release, presentation evidence and each handoff settlement
have an independent five-second storage budget, including queue wait, without inheriting caller or
open-time cancellation. Persistence failures reject or appear in the late settlement result; they never
claim successful persistence.

Codex producers only post. Each native async Stop receiver waits without holding claims, attempts one
idle queue handoff, then exits; PostToolUse presents synchronously during execution. Idle queueing
requires a reachable hosting app-server endpoint, not private stdio alone. See
[Codex delivery](codex-delivery.md) for native turn fencing, cancellation and recovery limits.
