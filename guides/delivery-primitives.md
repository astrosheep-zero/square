# Delivery ledger

`@astrosheep/square/delivery-ledger` exports `DeliveryLedger` and its types, also available from the
package root. The per-user ledger defaults to `~/.square/delivery.v5.sqlite` and stores producer-neutral,
finished text cards, session attachment, routes, attempts and receipts. Producers own content and
recipient selection; adapters own transport behavior. Routes contain only `{kind, address}`.
A card may also carry producer-neutral presentation `details`:
`{kind: 'presentation', origin, author?, ref?, at, reach, body}`. `at` is the landing time in epoch
milliseconds; `reach` is the typed landed route `mention`, `reply`, `attention`, or historical `bell`.
`text` is the finished bounded model-facing card; `body` holds the full raw Markdown for display.
Receivers validate these details and render them without opening producer storage; direct styling follows
the typed `reach`, while producer `label` remains plain display text. Cards without valid presentation
details remain plain text.

When Square lands an `act/N` in a file-backed square, it may dispatch a Tell only to seats whose
stored audience reason for that activity is `mention`. One activity may address several named seats;
each eligible seat has its own delivery key. The producer selects from those landed facts, never
from card wording or presentation details. Replies, listens, notices and other producers' cards
cannot start a Tell. The transport proves the target World and full AkuId, checks the route's stable
owner, and sends only awareness with the square, recipient and `act/N` to perceive. Tell is not
addressed back to the recipient as a Keiyaku initiator. A confirmed admission creates custody, not
a presentation receipt; uncertain admission is held, not replayed. The route is optional. The producer resolves the public
`@astrosheep/keiyaku` SDK from the installed Square package, or from an absolute SDK entry point
chosen by the launcher in `SQUARE_KEIYAKU_SDK`. It never loads a module or executable named in a
route or consults the sender's working directory for one. An absent SDK does not reject the activity
or mark it seen. See [the paired witness](keiyaku-wake-witness.md) for native verification.

Posting is idempotent by owner and key content. `DeliveryKey` is `readonly string[]`: nonempty
arrays for exact identities, with verbatim string segments (including empty strings and arbitrary UTF-16).
Prefixes may be `[]`, which selects every key in the chosen scope. String keys, sparse arrays, nested
arrays and nonstring segments are refused. No separator, escaping or normalization is implied. A prefix
`['a']` reaches `['a']` and `['a', 'b']`, while `['ab']` and `['a', 'b2']` remain distinct identities.
Methods snapshot key arrays before queuing work; returned arrays do not alias stored keys. Compare
fresh arrays with `deliveryKeyEqual`, or use `encodeDeliveryKey` for map/set identities. Storage uses
canonical JSON arrays; exact equality and descendant JSON ranges use the owner/key indexes.

Square owns its producer grammar:
`['square', canonicalPath, 'recipient', nameKey(recipient), 'join', joinGeneration, 'act' | 'notice', String(index)]`.
The prefix through `joinGeneration` selects one seat generation; `['square', canonicalPath]` selects
one square. Producer-neutral ledger code never parses these tags during ordinary operation.

Producer-push handoff and receiver-pull presentation have
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
bounded batches after 30 days. Deleted sessions lose cards, attempts and their owner suppressions;
the all-owner hold is independent of session deletion. Sessions detached
longer than 30 days lose cards and attempts. Session rows remain:
a deleted row is the authority for producer reconciliation and cannot be registered again.

`ledger.cards({owner, keyPrefix}, signal?)` reads existing card identities `{owner, key}` for one owner
through exact and descendant owner/key index ranges. Prefixes match whole elements; the result includes held cards, not only pending
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
to `history` by ID and cannot consume the full activity. Resetting a watermark to zero reproduces the
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
in [square-api.md](square-api.md). The ledger does not match producer metadata. The SQLite constructor
and row encoding are private to the ledger's storage owner. Ledger Format5 and Square Format13 are the
current runtime formats; ordinary opens refuse older files read-only. The exact offline conversion
rebuilds only the three key-bearing groups (`cards`, `receipts`, `suppressions`) and preserves all
other evidence.
The explicit offline Ledger4→5 and Square12→13 edges are described in [migration.md](migration.md).
The new default does not open or change older ledger files. `SQUARE_DELIVERY` still overrides the
default; an explicitly selected file must have a supported format.

`ledger.mute({durationMs}, signal?)` sets the one reserved null-owner `ledger-mute` hold from the
ledger's configured clock and returns `{mutedUntil}`; `ledger.unmute(signal?)` idempotently releases only
that row, and `ledger.mutedUntil(signal?)` reads its active deadline or `null`. Repeating mute replaces
its own expiry even when shortening it. Unmute repairs no custody and dispatches nothing; independent
seat, exact, prefix and permanent holds survive. Expiry is observed by ordinary reads and the existing
eligibility paths, without a scheduler or clock event. `DeliveryLedger.open({readOnly: true})` validates an
existing ledger without creating one.

`ledger.setSuppression({owner, id, key, scope, expiresAt}, signal?)` atomically sets one named finite
hold. A repeated id must match owner, key content and scope and already be timed; otherwise the
operation refuses without changes. Matching expired holds can be replaced, and a collected id is
recreated. Setting refreshes only that hold's creation and expiry times. Independent random holds
from `suppress()` and permanent exact tombstones remain independent.
`ledger.suppression({owner, id}, signal?)` returns the active row
`{id, owner, key, scope, createdAt, expiresAt?}`; expiry at or before the current clock is absent even
before collection. `renewSuppression` refuses expired/released holds; `releaseSuppression` removes
only the exact owner/id pair. Both also accept `owner: null`.

The sole all-owner combination is `{owner: null, id: 'ledger-mute', key: [], scope: 'prefix', expiresAt}`
with finite expiry. Its reserved id cannot be used by an owner hold. One row fences every owner's
post status, pending selection, presentation/handoff claims and final send guards. Suppressed new
cards are retained under the usual cap and retention; a later normal pull can resume after expiry
without another producer write. Holds do not recall external custody or invalidate truthful late
receipts. The global and Square-seat mute operations are thin callers of this row; they add no second
persisted mute fact, scheduler or clock event.

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
body-free idle wake, then exits. UserPromptSubmit fetches current cards at dequeue; PostToolUse
presents synchronously during execution. Queue admission is not card custody or presentation.
The native queue store is shared across hosting processes, including private stdio hosts. See
[Codex delivery](codex-delivery.md) for native turn fencing, cancellation and recovery limits.
