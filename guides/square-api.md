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
Each opened Square owns its artifact connection; `close()` releases it. File operations require an
explicit `path`. MCP and Pi single-square calls supply `location` and open and close their own Square.

`discover({cwd}, {owner?, depth?, limit?, after?})` finds nearby squares without selecting one. When
`owner` is supplied, each item includes that owner's joined names and their pending directed activity
counts; discovery does not consume them. The CLI `square list`, MCP `list`, and Pi `square_list` share
this discovery and its rendered text.

## Activity and delivery

`Participant.express` lands activity in Square, with optional immutable JSON `metadata` (maximum
16 KiB). Mentions, replies, bells, listening and ignores determine the landed audience. Activity IDs
are `act/N`. `Square.history` is the read-only archive; `Participant.perceive` consumes directed activity,
and `Participant.pending` reads addressed unconsumed says without consuming them. `listen`, `unlisten`,
`ignore`, `listening` and `done` operate on the participant. History, status and participants are
Square operations. `OperationControl` can carry cancellation; a committed mutation is not undone by
later cancellation.

Explicit mentions and body `@name` candidates share soft recipient resolution: absent or unknown
targets do not block `express`. The receipt lists them in `unmatchedMentions`; a departed reply author
is reported in `replyAuthorNotHere`. These warnings are not stored on the activity. CLI and tools
combine them into one deduplicated reach notice. Standing recipients still receive the activity;
rejoining later never adds a recipient to its frozen audience.

A live idle perceive owns matching activity notifications before producer export ownership is acquired.
Matching uses its sender and directed-attention filters against the activity's landed delivery route;
other activities and direct notices remain eligible. Release or expiry permits still-unconsumed activity
at the next ordinary posting opportunity; perceived or ACKed activity is not exported. Starting a perceive
cannot recall or retroactively suppress export ownership already committed.

After landing, Square renders and posts a card per audience member to the host delivery ledger using
`square:<canonical-path>#act/N/recipient/<encodeURIComponent(nameKey(recipient))>/join/<encodeURIComponent(capturedJoinGeneration)>`.
Notices use the analogous `notice/N` key. The recipient and participant join generation are frozen at
landing; ledger attachment rotation does not change the key. Post, receipt lookup and suppression use
the same captured coordinates. A later mutating operation retries unposted work idempotently. Directed
activity cards bound the body to 200 characters and point to `square_perceive` when shortened. Square records which cards contain
the full activity. Unread means after the read horizon, not perceived, and without a ledger receipt for
a full card. Square folds retained receipts lazily during privileged producer operations; perceive permanently suppresses
the corresponding ledger cards when possible. Ledger receipt evidence has finite retention: after proof
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
This limit is not a source TTL: it does not reject or expire never-exported sources, and perceive and ACK
remain available. A crash between export and bookkeeping leaves honest uncertainty. A token-fenced
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

Format 12 is a breaking fresh-store format. Square owns its activities, audience, participants, read
state and posting/full-card bookkeeping in the `.square` SQLite artifact. The per-user host delivery
ledger owns producer-neutral cards, attachment, routes, attempts and receipts; there is no discovery
index. Older artifacts are refused read-only: no migration, conversion or deletion. Host start/resume
and end attach/detach the ledger session, not Square seats. Host-confirmed deletion is reconciled to a
fenced `done` lazily by the next mutating operation, never by history, status or participants.

The package exports `DeliveryLedger` and its types from both the root and
`@astrosheep/square/delivery-ledger`. External producers post finished text and own their content;
the ledger does not match producer metadata. Proactive delivery suppression uses the ledger's exact
or prefix `suppress` operation, with an optional expiry; see [delivery-primitives.md](delivery-primitives.md).
