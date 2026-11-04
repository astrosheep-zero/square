# Delivery ledger

`@astrosheep/square/delivery-ledger` exports `DeliveryLedger` and its types, also available from the
package root. The per-user ledger defaults to `~/.square/delivery.v3.sqlite` and stores producer-neutral,
finished text cards, session attachment, routes, attempts and receipts. Producers own content and
recipient selection; adapters own transport behavior. Routes contain only `{kind, address}`.

Posting is idempotent by owner and key. Producer-push handoff and receiver-pull presentation have
separate attempt tracks, with cross-track exclusion based on ledger attempt state. Accepted or unknown
handoff does not establish presentation; uncertain effects must not be blindly replayed. Presentation
receipts record only the cards confirmed by the receiving boundary. A receipt means observed at that
boundary, not model comprehension. An observer may not detect a later plugin removing a card.
Receipt retention is finite: once evidence expires, Square retains unproved local unread until catch
or ACK, rather than inventing consumption or reinserting an uncertain old card.

Square folds receipts lazily into its own read state only for full activity cards; a shortened activity
card points to `square_catch` and cannot consume the full activity. Catch permanently suppresses the
corresponding ledger card where possible. Cancellation suppresses outstanding work without claiming it was seen and cannot
recall an external send already past its final check. The ledger has no metadata matching or deferral
API; producer-owned leases and exact ACK are described in [square-api.md](square-api.md).

Square posting, the Codex sweep and OpenCode receivers retain their original ledger connection while
an already-invoked handoff has a pending `lateSettlement`. Timeout or cancellation returns promptly;
the connection closes after the last captured effect settles. It holds no open SQLite transaction and
grants no further send authority after the caller stops. An effect that never settles may retain an
idle connection until process exit. Late persistence failures produce redacted diagnostics rather than
reopening the ledger or retrying the effect. Pi presentation and Claude's independent exact-reference
confirmation callbacks retain their existing lifetimes.
