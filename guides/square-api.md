# Square and Participant API

`Square` is the concrete resource shared by SDK, CLI, MCP and Pi; `square.ts` is the CLI
entrypoint. `square-facade.ts` declares public operation types, not a second execution path. See
[attention-primitive.md](attention-primitive.md) for audience computation and
[delivery-primitives.md](delivery-primitives.md) for the host delivery ledger.

## Open and join

```ts
import { Square } from '@astrosheep/square';

const square = await Square.at({ path: './discussion.square' });
try {
  const { participant: alice } = await square.join('Alice', { owner: 'example:alice' });
  const sent = await alice.express('Hello @Bob', { force: true });
  const page = await square.history();
  console.log(sent.activity.id, page.activities);
} finally {
  await square.close();
}
```

`Square.at`, `Square.build` and `Square.inMemory` open resources; an owner is supplied per join or
selection, never captured as the resource's default participant. Owners are opaque non-secret strings,
not authorization credentials. Adapters resolve their own harness identity without rewriting process
environment. Membership is explicit; `PUBLIC.square` is an ordinary filename. A participant handle
captures owner and join generation; rejoin or takeover fences old handles. `done` ends membership;
host attachment is separate, as described in [participant-ownership.md](participant-ownership.md).
Each opened Square owns its artifact connection; `close()` releases it. Delivery location resolves once
at resource entry: explicit `ledgerLocation`, then `SQUARE_DELIVERY`, then the per-user default.
Internal posting and session helpers require that resolved absolute path, including at runtime.
File operations require an explicit `path`. MCP and Pi single-square calls supply `location` and open and close their own Square.

`discover({cwd}, {owner?, depth?, limit?, after?})` finds nearby squares without selecting one. When
`owner` is supplied, each item includes that owner's joined names and their pending directed activity
counts; discovery does not consume them. The CLI `square list`, MCP `list`, and Pi `square_list` share
this discovery and its rendered text.

## Activity and delivery

`Participant.express` lands activity in Square, with optional immutable JSON `metadata` (maximum
16 KiB). Mentions, replies, listening and ignores determine the landed audience. Activity IDs
are `act/N`. Historical bell activities retain their original audience, body and ID. `Square.history` is
the read-only archive; `Participant.perceive` consumes directed activity,
and `Participant.pending` reads addressed unconsumed says without consuming them. `listen`, `unlisten`,
`ignore`, `listening` and `done` operate on the participant. History, status and participants are
Square operations. `OperationControl` can carry cancellation; a committed mutation is not undone by
later cancellation.

The package root also exports the syntax Square validates with: `parseActivityId`,
`NAME_GRAPHEME_SOURCE`, `PARTICIPANT_NAME_SOURCE` and `isParticipantName(name)`. They share the core
acceptance, so adapters use them instead of copying the grammar.

`Participant.mute({durationMs}, options?, control?)` installs one timed hold for the handle's captured
owner, name and join generation; `Participant.unmute` releases only that named seat hold. Duration is a
positive safe integer in milliseconds. The Square clock sets the deadline, a stale handle cannot affect a
newer join, and repeat mute replaces only its own deadline. Independent seats, other squares and producer
holds are untouched. No activity lands and no pending card is dispatched by installing a hold.

The standalone global helpers `muteDeliveryLedger({durationMs, ledgerLocation?, clock?}, control?)`,
`unmuteDeliveryLedger(...)` and `deliveryLedgerMutedUntil(...)` operate on the resolved host delivery
ledger and need no owner or `.square` file. They use exactly the null-owner `ledger-mute` row; global and
seat holds never release one another. `StatusResult.ledgerMutedUntil` and `DiscoveryResult.ledgerMutedUntil`
carry an active global deadline, and `ParticipantSummary.mutedUntil` / each owner-held
`SquareListItem.joined[].mutedUntil` carry an active captured-seat deadline. Expired rows are omitted by
the configured clock. Read-only status/list enrichment opens an existing ledger without creating one;
`participants({local: true})` stays artifact-only. Callers own polling and timers: expiry has no event or
daemon, and a hold never recalls custody already handed to a receiver.

Explicit mentions and body `@name` candidates share soft recipient resolution: absent or unknown
targets do not block `express`. The receipt lists them in `unmatchedMentions`; a departed reply author
is reported in `replyAuthorNotHere`. The optional `awayRecipients` lists directed joined targets
observed detached by the reconciliation immediately before landing, without requiring `observe: true`.
It covers resolved mentions and a joined reply author, deduplicates canonical names and excludes the
speaker. The landing transaction fences each observation to the same owner and join generation.
Missing sessions, unknown observations, routes and cached attachment alone do not establish away status.
These facts are not stored on the activity and do not prove delivery, consumption or current unread
state. The captured observation remains unchanged by later attach, detach or receipt activity.

CLI and tools share one `⚠ @Alice is not in this square.` per absent target,
and one `⚠ @Bob is away.` per observed away target. Away names use the resolved participant
identity; unmatched names retain the requested spelling.
Absent mention and reply warnings deduplicate. Joined addressed recipients retain their frozen audience
and unconsumed activity while away; they can perceive after resume without joining again. Ignore still
controls audience, so an away warning for an ignored sender's target does not imply unread activity.
Rejoining later never adds an absent recipient to an earlier activity's frozen audience.

A live idle perceive owns matching activity notifications before producer export ownership is acquired.
Matching uses its sender and directed-attention filters against the activity's landed delivery route;
other activities and direct notices remain eligible. Release or expiry permits still-unconsumed activity
at the next ordinary posting opportunity; perceived or ACKed activity is not exported. Starting a perceive
cannot recall or retroactively suppress export ownership already committed.

After landing, Square renders and posts a card per audience member to the host delivery ledger using
`square:<canonical-path>#act/N/recipient/<encodeURIComponent(nameKey(recipient))>/join/<encodeURIComponent(capturedJoinGeneration)>`.
Notices use the analogous `notice/N` key. The recipient and participant join generation are frozen at
landing; ledger attachment rotation does not change the key. Post, receipt lookup and suppression use
the same captured coordinates. A later mutating operation retries unposted, unconsumed work for current
joined seats idempotently, and retries dispatch of their existing pending ledger cards when their host
has a producer-dispatchable route. No-route and native-receiver-only hosts still receive exported ledger
cards; producer dispatch skips their pending enumeration. Directed
activity cards bound the body to 200 characters and point to `square_perceive` when shortened. Square records which cards contain
the full activity. Unread means after the read horizon, not perceived, and without a ledger receipt for
a full card. Square folds retained receipts lazily during privileged producer operations: it reads after
each current attached owner's artifact watermark, then folds eligible exact records and advances that
watermark in the same artifact transaction. Receipt sequences follow ledger commit order; watermark
updates are monotonic, including receipts belonging to other producers. Only full, unconsumed cards
matching the current joined seat can fold. The ledger caps retained notifications at 200 per owner,
withdrawing oldest noncustody cards while preserving dispatching, unknown and unpresented accepted
custody. Cap withdrawal leaves producer activity unread and available to pending and perceive.
Perceive withdraws corresponding live ledger cards when possible. Withdrawal maintenance reads owner/key
ranges for current owners and outstanding departure intents, plus in-window export claims. Seat removal
records a departure intent atomically; stale exporter settlement refreshes its token, and cleanup clears
only its captured version after suppression succeeds. Gone cards without such claims do not
recreate expired ledger suppressions. Ledger receipt evidence has finite retention: after proof
expires, locally unproved activity remains unread until explicit perceive or ACK. Missing evidence proves
neither consumption nor non-delivery. A shortened card cannot consume the full activity. Handoff
acceptance is not presentation; a boundary receipt is not proof of comprehension.

`Square.send({from, to, body, metadata?}, control?)` creates a producer-owned notice, not a say or a
membership. `to` is a participant name or readonly array of names. It returns Square-owned
`SendResult` `{id, at, from, to, body, metadata?}` with `id: notice/N`, distinct from `act/N`.
Recipients are frozen when the notice lands. The delivered notice text is exactly the supplied body,
including its original newlines; no sender label or metadata is added to that text. Sender and metadata
remain producer facts for queries and exact ACK. There is no sender truncate or preview option.
Notices use the same producer export ownership path as activity cards.

## Queries and acknowledgement

`Square.participants({local: true, observe?: true}, control?)` reads only World-known participant
facts, including known departure and attachment state. It needs no host ledger access and does not
prove current host liveness; `deliveryAvailable` is false in this mode. The default query still overlays
host attachment and route availability. Local discovery can distinguish known names before selection;
it does not grant custody or allow fallback over a departed, foreign or detached identity.

`Square.history` returns `{activities}` without consuming; `Participant.pending` returns
`{activities, remaining}` oldest first. Activity queries support exact IDs, senders, metadata matches,
search and exclusive `act/N` cursors. Filters combine with AND. History defaults to ten records;
`limit: null` requests the complete archive. Pending defaults to 100 and accepts limits 1–100.
A pending read does not claim work or change the read horizon.

`Participant.ack(ids: readonly ActivityId[], control?)` remains the exact-ID consumption operation,
returning `{consumed}`. All IDs must be addressed to the participant; invalid or unaddressed IDs
reject the batch. Duplicate and already consumed IDs are idempotent. It does not assert presentation.

For producer waiting, the explicit opt-in
`Participant.ack({from: string, match: MetadataMatch, future: 'exact'}, control?)` returns
`Promise<{consumed: number}>` and records a durable recipient-scoped sender and metadata predicate,
including for a matching notice inserted later. Zero consumed still means the future consumption fact
committed. This is exact equality of each specified nested scalar field, not equality of the whole
metadata object, nor a prefix or wildcard match. Supply the full outcome identity; unrelated recipients
and outcomes remain unaffected. The ordinary ID form does not create a future predicate.

Insertion, ACK and producer export ownership serialize in World storage. Once export ownership commits,
the asynchronous ledger post runs outside that transaction: a later ACK cannot promise recall. The
fact remains until the producer can prove the corresponding source cannot be inserted or exported
again; no TTL or first-admission cutoff is required. Producer bookkeeping records the immutable
`firstPossibleExport` at initial export ownership using actual host time, on the ledger's clock basis.
A claim is recoverable when its process dies or its 60-second ownership expires; settlement is fenced
to the captured token. An abandoned uncertain export at or beyond the ledger's minimum 30-day identity
retention window is not automatically reinserted. Clock or boundary uncertainty is treated conservatively.
Pending export selection excludes existing claims outside that original identity window or ahead of
the actual host clock (including a future recovery claim), before acquiring export ownership. The Square's
social clock is not used for this selection. This limit is not a source TTL: it does not reject or expire
never-exported sources, and perceive and ACK remain available. A crash between export and bookkeeping leaves honest uncertainty. A token-fenced
initial attempt proved not to have invoked insertion, or given a definite insertion refusal, releases
its export bookkeeping while keeping the source pending. Recovering a prior uncertain attempt never
erases its original export time merely because the current retry was unsent.

`MetadataMatch` has nonempty `fields` with nonempty path segments and exact, type-sensitive scalar
`equals` values (`null`, boolean, finite number or string). Only own object properties are traversed;
arrays and missing intermediates do not match. Fields combine with AND.

Sandbox participant selection and exact ACK check captured owner, join generation and locally
known lifecycle in World storage only. They do not need ledger access and do not prove host liveness.
Ledger-only detach or delete is learned at the next privileged producer reconciliation; actual export
is gated by the ledger's current state. Local controls cannot grant delivery authority or resurrect a
deleted session. Known stale, departed or replaced custody refuses.

## Storage and lifecycle

Receipt folding reads only sequences after each owner watermark. Ledger card lookup uses owner/key
ranges, and permanent suppression retention uses a `created_at` index. Producer pending selection still
searches retained say/audience history, withdrawn-claim selection searches posting rows, and
`read_through` aggregates retained read activities; these remaining physical reads can grow with history.

Format 13 owns activities, audience, participants, read state, posting/full-card bookkeeping,
receipt watermarks and outstanding departure intents in the `.square` SQLite artifact. The per-user
host delivery ledger owns producer-neutral cards, attachment, routes, attempts and receipts; there
is no discovery index. Ordinary artifact opens accept only Format 13. The sole explicit upgrade
edge is offline Format 12→13 through the standalone `migrateSquare` export:

```ts
import { migrateSquare } from '@astrosheep/square';

const result = await migrateSquare({ cwd: process.cwd(), path: './example.square' }, { signal });
// { location: absolutePath, fromVersion: 12, toVersion: 13, changed: true }
// A fully validated Format13 returns fromVersion: 13 and changed: false, read-only.
```

Stop all old writers first. The operation uses the normal `SquareLocation` path resolution and
requires an existing `.square` file. It never opens `Square`, resolves a delivery ledger, or attaches
a host session. Every old logical row and revision stays unchanged; receipt watermarks start empty.
See [migration](migration.md) for refusal, atomicity and departure backfill details.

Ledger Format5 uses array-path identities and defaults to `~/.square/delivery.v5.sqlite`.
Its separate explicit offline Format4→5 edge is `migrateDeliveryLedger({location,
convertOpaqueKey?, convertOpaquePrefix?}, {signal}?)`, exported through `square-api`, the package
root and `@astrosheep/square/delivery-ledger`. All opaque producer identities require their own
synchronous converters; known canonical Square keys convert directly. The migration preserves
custody and receipts without sending, normalizing or collecting evidence. Ordinary opens never
upgrade an existing file. Stop all hosts/producers and coordinate their array-key release
before any real ledger cutover; see [migration](migration.md).
All other artifact versions and older ledgers are refused without conversion or deletion. Host start/resume
and end attach/detach the ledger session, not Square seats. Host-confirmed deletion is reconciled to a
fenced `done` lazily by the next mutating operation, never by history, status or participants.

The package exports `DeliveryLedger` and its types from both the root and
`@astrosheep/square/delivery-ledger`. External producers post finished text and own their content;
the ledger does not match producer metadata. Every key is a `readonly string[]` compared by content;
whole-element prefixes may be `[]`. Proactive delivery suppression uses exact or prefix `suppress`
with optional expiry, or finite independent named holds through `setSuppression`. The reserved
null-owner `ledger-mute` hold applies globally without per-owner rows and is installed or released by
the mute helpers above. See [delivery-primitives.md](delivery-primitives.md).
