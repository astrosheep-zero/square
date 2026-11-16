# Delivery ledger

`@astrosheep/square/delivery-ledger` exports `DeliveryLedger` and its types, also available from the
package root. The per-user ledger defaults to `~/.square/delivery.v3.sqlite` and stores producer-neutral,
finished text cards, session attachment, routes, attempts and receipts. Producers own content and
recipient selection; adapters own transport behavior. Routes contain only `{kind, address}`.
A card may also carry producer-neutral presentation `details`:
`{kind: 'presentation', origin, author?, ref?, at, reach, body}`. `at` is the landing time in epoch
milliseconds; `reach` is `mention`, `reply`, `attention`, or `bell`. `text` remains the bounded model-facing
card; `body` holds the full Markdown for display. Receivers validate these details and render them
without opening producer storage. Cards without valid presentation details remain plain text.

Posting is idempotent by owner and key. Producer-push handoff and receiver-pull presentation have
separate attempt tracks, with cross-track exclusion based on ledger attempt state. Accepted or unknown
handoff does not establish presentation; uncertain effects must not be blindly replayed. Presentation
receipts record only the cards confirmed by the receiving boundary. A receipt means observed at that
boundary, not model comprehension. An observer may not detect a later plugin removing a card.
Receipt retention is finite: once evidence expires, Square retains unproved local unread until perceive
or ACK, rather than inventing consumption or reinserting an uncertain old card.

The ledger caps retained cards at 200 per owner on post, withdrawing the oldest cards without custody.
Dispatching, unknown and accepted-but-unpresented handoffs are exempt, so custody can keep the total
above 200. Cancelled and temporarily suppressed cards count toward the cap. Withdrawal affects only
notifications: producer content stays unread and remains available to pending, perceive and ACK.

The ledger is an outbox. Accepted and unknown attempts drop card text and details in the same
transaction, retaining only custody so an exact late observation can still write a receipt. A presented
presentation attempt deletes its card and attempts once no attempt is dispatching; a permanent exact
suppression prevents reposting the key. Unconfirmed accepted/unknown custody expires only after
30 days from its latest settlement. Failed and released attempts keep content for retry. Cards with no
dispatching, accepted or unknown attempt expire in bounded batches after 30 days from posting, leaving
permanent exact suppressions just like presented cards. Receipts and permanent suppressions expire in
bounded batches after 30 days. Deleted sessions lose cards, attempts and suppressions; sessions detached
longer than 30 days lose cards and attempts. Session rows remain:
a deleted row is the authority for producer reconciliation and cannot be registered again.

`ledger.cards({owner, keyPrefix}, signal?)` reads existing card identities `{owner, key}` for one owner
through the owner/key unique range index. Prefix matching is literal; the result includes held cards, not only pending
ones, and carries no producer-specific interpretation. Producer dispatch skips pending enumeration when
a cached attached session has no producer-dispatchable route (no routes or only native receiver routes).
This never blocks producer export, receipt folding or withdrawal; actual dispatch retains its per-card
session and generation checks.

`ledger.receipts(owner, {afterSeq?, keys?, since?}, signal?)` returns `{seq, owner, key, at}` in sequence
order. Receipt sequences are allocated in the ledger writer transaction, so sequence order follows
commit order even when timestamps do not. Square reads after its artifact-owned watermark per current
attached seat owner, then folds eligible receipts and advances that watermark in one artifact transaction.
The watermark advances past unrelated producer receipts too; concurrent reconciliation cannot lower it.
Only unconsumed full cards matching the current joined seat can fold; a shortened activity card points
to `square_perceive` and cannot consume the full activity. Resetting a watermark to zero reproduces the
retained full scan. Producers never delete ledger receipts.
Perceive suppresses corresponding live ledger cards where possible. Withdrawal uses owner/key ranges
for current seat owners and outstanding departure intents, plus in-window export claims that could still
insert a card. Seat removal records its captured departure intent atomically. A late export settlement
for that old seat refreshes the intent; cleanup clears only the captured token after successful
suppression, preserving recovery across crashes and concurrent settlement. Completed departure intents
do not accumulate as history. Once neither a card nor such a claim remains,
later Square operations do not recreate expired suppressions. Pending export selection excludes expired
or future-clock export identities using host time, without a TTL on never-exported sources or deletion
of producer evidence. Cancellation suppresses outstanding work
without claiming it was seen and cannot
recall an external send already past its final check. Producers can call
`ledger.suppress({owner, key, scope: 'exact' | 'prefix', expiresAt?})` to suppress one key or a key
prefix. Omit `expiresAt` for permanent suppression within ledger retention, or supply an expiry for
temporary suppression. This does not consume Square activity; producer-owned exact ACK is described
in [square-api.md](square-api.md). The ledger does not match producer metadata. Ledger Format 4 and
Square Format 13 require fresh stores; older formats are refused read-only, without migration or deletion.
The default ledger filename remains `delivery.v3.sqlite`, so an old file at that path is also refused.
Permanent suppression retention drains through a partial `created_at` index. Pending producer selection
still searches retained say/audience history, withdrawn-claim selection searches posting rows, and
`read_through` aggregates retained reads.

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
