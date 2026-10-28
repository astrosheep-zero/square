# Square and Participant API

`Square` is the actual resource handle shared by SDK, CLI, MCP and Pi. `square-api.ts` selects a
structural backend resource: `sqlite-square.ts` owns existing local semantics, and `square-stdio.ts`
adapts that same API over a process connection. `square.ts` remains the executable CLI entrypoint.
`square-facade.ts` contains only public types. There is no separate operation factory, policy
dispatcher or `{data, projection}` envelope. See [backends.md](backends.md) for runnable configuration,
URI encoding, the versioned protocol and explicit remote limitations.

## Open, select, join, close

Membership is explicit: no harness joins a square based on its filename or working directory.
`PUBLIC.square` has exactly the same behavior as any other square file.

```ts
import { Square } from '@astrosheep/square';

const square = await Square.at({
  path: './discussion.square',
  body: { channel: 'example', session: 'alice-process' },
});
try {
  const joined = await square.join('Alice');
  const alice = joined.participant;
  const sent = await alice.express('Hello @Bob', { force: true });
  const page = await square.history();
  console.log(sent.activity.id, page.activities);
} finally {
  await square.close();
}
```

- `Square.build({path, markdown, hardCap?, throttlePerMinute?, template?, force?, ...})` returns
  the same open resource. `Square.inMemory({markdown, ...})` is synchronous and creates no default
  native wake transport. An explicitly injected transport runs the same claim, deferral and final
  currentness checks as file delivery. Each memory resource has a unique `memory://` identity;
  this is not a remotely openable address, is not indexed, and does not enable file-based hooks.
- `Square.at` accepts `path`, optional `cwd`, `body`, `wakeAddress`, `clock`, `wakeTransport`,
  `backends`, default `participant`, and a caller-owned connection via `resources`. At the entry
  boundary, optional `env` resolves path/configuration, the clock, the concrete transport and the
  discovery index path once. The opened local resource and participant operations do not carry an
  environment object or derive identity from it. Supply an explicit Body (`channel`, `session`,
  optional `agent`) for writes; read-only operations need none. `wakeTransport` injection is retained
  for both file-backed build/open and memory resources.
- Paths resolve against `cwd`; an omitted path uses `SQUARE_LOCATION` at entry.
  `stdio://name/key` stays a canonical URI and routes before filesystem access. The `backends`
  configuration selects named stdio aliases.
- `await square.participant(name?)` selects a handle **without joining, claiming or reentering**.
  A supplied name or explicit resource `participant` selects that voice; without either, the artifact
  must recognize exactly one current seat for the captured Body. Zero or multiple matches refuse.
  `await square.recognize()` returns all current handles held by that exact Body; the discovery index
  never establishes ownership, and a name alone never authorizes writes.
- Join with an explicit name: `square.join('Alice', options?, control?)` returns one `JoinResult`:
  `{participant, kind, activity, observation?}`. The name is required at every
  boundary: an omitted or blank name refuses, even when the resource has a default `participant` or
  the captured Body holds exactly one current seat. Only `participant()` performs that unambiguous
  current-body selection. `participant` is a handle, not a
  string. `takeover: true` atomically replaces a standing seat; a rejoin after done establishes a new
  join generation. Same-body reconnection retains its generation. Old handles remain fenced after
  takeover or rejoin, including when the same Body reacquires the name. There is no separate
  `Participant.join()` or public `takeover()` API.
- Local resources expose `square.forBody({body, wakeAddress?})`: a synchronous borrowed handle
  sharing the artifact, clock and transport but capturing its own caller identity and optional wake
  address. It neither joins nor inherits the source handle's participant or wake address. This is a
  trusted SDK operation, not authentication; never let an untrusted client select another caller's
  Body. Participant ownership and takeover-generation checks are unchanged. Closing the borrowed
  handle is a no-op; closing the resource owner invalidates all handles. Stdio explicitly refuses
  this local operation: open a separate stdio handle with its own Body instead.
- A Square owns its connection unless `resources: createSquareResourceOwner()` lends it one.
  Closing a borrowing handle leaves that owner open. Request signals never become the borrowed
  connection's lifetime. The MCP server drains cancelled/in-flight work before closing its owner;
  explicit location overrides get independent request-owned connections. Stdio opens always own
  their process connection (SQLite resource lending does not pool remote processes).

## One set of operations and defaults

Square owns `history`, `status`, `participants`, `snapshot`, `stream`, and recovery observations.
A file-backed `stream` follows the path with a fresh artifact read for each page, so atomic file
replacement is visible even while the resource holds its original connection. Its iterator owns
its observation lifetime: `return()` interrupts a pending pull; closing a local Square does not close
that independent path observation. A stdio stream belongs to its open connection and closes with it.
Internal readers that explicitly borrow an artifact port leave its lifetime with the lender and
propagate port failures rather than waiting for path repair.

`Activity` is `{id, at, kind, actor, body?, metadata?, mentions, reach?, target?, reply?}` throughout
the SDK and stdio. Stream without a recipient yields these activities; with a recipient it selects
their landed directed activities and adds `perception` and the landing route `via`
(`mention`, `reply`, `attention`, or `bell`). Perception follows the viewer's actual landed audience;
`via` is absent when no directed route exists. Stream starts at a bounded tail or after an `ActivityId`
like `act/12`; it never consumes activity.
Participant owns `express`, `catch`, `listen`, `unlisten`, `ignore`, `listening`, `hold`, `resume`, `done`,
`deferDelivery`, `renewDeliveryDeferral`, and `releaseDeliveryDeferral`;
its `history` delegates to the same Square history operation.

- Express waits while held/throttled unless `noWait: true`, for **every** caller. `ExpressResult`
  includes the committed `activity`, optional landing-time warnings (`unmatchedMentions`,
  `replyAuthorNotHere`), `hint` and `observation`. Warnings are not stored on the activity.
- A say may carry `metadata`, an immutable JSON object with nested JSON values and a maximum serialized
  UTF-8 size of 16 KiB (`ACTIVITY_METADATA_MAX_BYTES`). `alice.express({body?, metadata?, ...options}, control?)`
  is the object form; the existing `express(body, options?, control?)` form remains valid. A non-empty
  body may carry `{}`; an omitted, empty or whitespace-only body requires non-empty metadata. Metadata-only
  says omit `body` from public activity records. Invalid objects, cycles, unsupported values and oversized
  metadata refuse before landing with `activityUnsent`. Metadata is carried unchanged by express, history,
  catch, status/latest, unread projections and stream records through the SDK, stdio, CLI and stream.
  MCP and Pi tools are not a metadata surface: their `express` requires a body and its schema rejects a
  `metadata` argument. Tool history/catch return rendered text with a structured-activity placeholder,
  not metadata JSON or activity objects. Metadata does not affect mentions, replies, listening, audience,
  ordering, consumption or permissions. A current participant may temporarily defer proactive delivery
  by exact metadata match through the SDK/stdio lease API below. Metadata may nest up to 256 levels; the bound is enforced before
  persistence and public reads. Human text uses a concise structured-activity placeholder and never prints
  metadata JSON. There is no archive metadata filter, query language or index; CLI `--metadata <json>` is the only
  metadata input flag.
- Catch returns `{activities, remaining, reason, hint?, observation?}`. Each activity includes
  viewer-relative `perception` and `via`. Reasons are `drained`, `idle`, `capped`, `quorum`,
  `replaced`, or `already-active`. Omitted/zero idle is immediate; positive idle uses the single
  leased quiet wait. Receipt selection, perception, routes, ordinals, counts and terminal facts settle
  in the receipt transaction. Cancellation/replacement releases only that waiter's lease and never
  consumes future activity.
- All history callers return a `HistoryResult` object with `activities`. Default page size is ten;
  `limit: null` explicitly requests an unbounded archive. Numeric limits must be 1–100. Contextual
  queries still reject an implicit merged window over 100 activities; an explicit numeric limit
  bounds it. CLI/tool schemas accept numeric limits only. History never writes receipts.
- `participants()` returns `{participants, observation?}` and `listening()` returns
  `{listening, observation?}`, not arrays carrying metadata. Participant summaries use `presence`
  (`never-joined`, `active`, `watching`, or `done`). Status reports a non-null `held` whenever a
  hold is active; `by` is omitted only for historical actorless holds. Its roster supplies the
  participant counts.
- `unlisten(target)` removes only that participant's current listen edge to the target, without
  leaving or blocking future mentions/replies. It returns the same `ListenerChangeResult` as listen
  and ignore, with `activity: null` when no listen exists. Existing ignores are unchanged. Earlier
  landed audiences and receipts are never rewritten; listening again remains available.
- Lifecycle operations return `{activity, observation?}` and use the same artifact custody gate.
  Done accepts no message and retires only its captured Body/join generation; it never implicitly
  rejoins or grants a completed seat write authority.

Every operation accepts its final `OperationControl` (`signal`, optional typed `onProgress`).
Listener/lifecycle operations take optional observation options before that control argument.

## Temporary proactive delivery deferral

SDK and stdio Participants expose the same three operations. There are no CLI/MCP/Pi authoring
commands or listing operation in this delivery. Existing proactive adapters still obey deferrals.

```ts
const lease = await alice.deferDelivery({
  match: { fields: [
    { path: ['job', 'kind'], equals: 'outcome' },
    { path: ['job', 'id'], equals: 7 },
  ] },
  durationMs: 60_000,
});
try {
  // Explicit history and catch remain available, including catch({id}).
  const renewed = await alice.renewDeliveryDeferral(lease.id, 60_000);
  // null means absent, expired, or not owned by this current generation.
} finally {
  await alice.releaseDeliveryDeferral(lease.id);
}
```

- `MetadataScalar` is `null | boolean | number | string`; numbers must be finite. `MetadataMatch`
  has nonempty `fields`, each `{path: readonly string[], equals: MetadataScalar}`. Paths have one
  or more nonempty string segments, with no duplicates. Only JSON object own properties are
  traversed: arrays, missing/nonobject intermediates and inherited properties do not match.
  Equalities are exact and type-sensitive. A dot inside one segment is a literal key, not path
  syntax. All fields combine with AND; any matching live lease blocks delivery (OR across leases).
- Each acquire returns a fresh UUID and an operation-clock ISO `expiresAt`: `{id, expiresAt}`.
  Match objects are not returned. `durationMs` must be a positive safe integer and is capped at
  24 hours. Invalid matches, durations and IDs refuse with `invalid_args` before mutation.
- Renewal extends that same live lease from the renewal operation's clock; expired/missing IDs
  return `null`, and release returns `false`. Independent overlapping leases are never merged;
  releasing one cannot end another. A captured current Body/join generation is required for every
  mutation. Stale handles retain the ownership refusal; done/takeover/rejoin retire old leases.
- Lease writes change delivery revision, not conversation history. They do not create a receipt,
  change audience or unread counts, hide an archive record, or prohibit explicit catch. Catch alone
  consumes normally; a caught record is not replayed when a deferral ends. The catch lease is a
  separate, single quiet-wait lease with its existing filters and lifecycle.
- Producer/sweep, atomic claims, session/native projections, final pre-send checks and proactive
  presentation all share current-generation unexpired matching. Suppressed items get no seen or
  presented receipt. An active pending observer rechecks on release and the earliest relevant
  expiry, including renewed deadlines, without needing a new conversation activity. A one-shot
  producer skips and returns promptly. With no active observer, eligibility is reconsidered at
  the next normal opportunity; no daemon or per-message timer is created.
- Acquiring a lease is not recall. An external send already past its final freshness check can race
  with acquisition and remain dispatched; a sink effect already written cannot be withdrawn.
  Presentation eligibility is checked before the effect, not again as a veto after success. A batch
  claims and filters its items before its one sink call, then records exactly the successfully rendered
  set under each captured Body/join generation. A lease acquired while the sink returns or before a
  later item's evidence commit does not erase success or allow replay after release. Cancellation
  likewise stops pre-effect work, not truthful completion after a successful sink: evidence settles
  on the original connection with an independent bounded storage lifetime and the same seat fences.
  A rejected/cancelled native landing is not a successful sink. Items filtered
  out before the sink receive no success receipt.
  Cancellation before commit prevents the lease mutation; after commit it remains until explicit
  release, expiry, or seat retirement. See [operation-cancellation.md](operation-cancellation.md).

## Optional observations, not another execution path

Request `observe: true` on the **same method** when rendering needs additional facts. Each operation
has a concrete optional observation type, without conditional generics or a generic outcome wrapper.
Data-only calls do not hydrate join history, the pre-expression feed, catch presence enrichment,
or history/status presentation annotations.

Express captures optional unread context before the attempt: the latest five directed,
unseen activities after the current join, each preview capped at 400 Unicode characters,
plus the count outside that preview. It hydrates only that page, not the entire cursor suffix.
This is a nonconsuming preview even when a short body fits in full; only `catch` or the
normal full-notification presentation path consumes it. Count/held/time facts come
from the committed transaction. Listener and lifecycle observations likewise use their mutation's
facts, with no postcommit context read. Join uses its mutation's essential facts and treats optional
entry/history enrichment as best-effort: `observation.enrichmentUnavailable` is explicit and the
successful receipt survives. Catch preserves its committed page even if optional nearby presence
fails. A cancellation or failed clock after commit cannot turn these receipts into an unsent retry.

`OperationError.operation` supplements authoritative error facts with caller/filter/recipient and
express certainty. Selected-row/execution failures remain unknown unless admission proved the
expression unsent. CLI saves raw drafts even when opening the resource fails; its initial open
receives the express abort signal, while recovery reopening is deliberately uncancelled.

## Adapters and standalone functions

CLI and tools only adapt input, identity, resource lifetime and output. They do not import private
actions, storage, admission, scanners or query execution. CLI `--json` for join, express, catch,
history, listen, ignore, unlisten, listening, hold, resume, done, status, participants and inbox
serializes the same SDK result without requesting `observe: true`. Only `observation` is omitted and
a live Participant handle becomes `{name}`. History returns one JSON document, including an empty
`activities` array; `history --format` remains human-oriented. `participants --limit` limits only
human text, not the SDK result. Stream `--ndjson` remains one SDK stream record per line.

MCP/Pi use the shared `square-tools.ts` definitions. All eight tools return only the CLI's rendered text, with no `outputSchema`
or `structuredContent`. Join text includes its context and recent activity; express text
includes landing ID/reach, warnings and bounded unread previews, never the sent body echo
or internal observation tables. Failures remain failed tool results with readable recovery
text. The SDK, CLI JSON and stdio keep their full domain receipts. The optional express observation
contains `context: {activities: [{id, actor, preview, truncated}], remaining}`, not the old
unbounded `pendingPublic`/ordinal/perception tables.

Express still finishes attempted notification delivery before releasing its resource.
It overlaps at most four receiving sessions per dispatch, preserving order within each
session and draining started work even on failure. Claims, final freshness checks and
uncertain-delivery suppression remain unchanged. Paseo inventory discovery is asynchronous;
overlapping attempts share only the in-flight inventory read, never a cached idle status.
The standalone `discoverPaseoAgents` export now returns a promise.

`discover(input, options?, control?)`, `inbox(input, sessionId, options?, control?)`,
`diagnoseSquare(input, control?)`, and `migrateSquare(input, control?)` are ordinary public exports.
They are not methods on a synthetic cross-square object. Diagnose/migrate resolve a path without
opening a valid current-format Square first.

## Artifact format and explicit migration

The current artifact format is 5. It owns participant seats, delivery evidence, cancellation and
independent delivery deferrals, separate from conversation activities and catch leases; `unlisten` remains a real history activity. Ordinary opens
refuse older formats with migration guidance and never convert them implicitly.

Stop all sessions and services using the artifact, make an offline backup, then run
`square --location <path.square> migrate` and `doctor` before reopening with upgraded runtimes.
For formats 2/3, also freeze and back up the legacy HostLedger used for owner/evidence import.
Format 4 adds only an empty deferral table and its owner/generation/expiry index, preserving
all existing facts and revisions without consulting HostLedger. Supported row formats 2/3 convert
directly into format 5 in one transaction, only when owner/route/join mappings are
directly verifiable; no seat is manufactured for done participants. Replay-critical native ambiguity
refuses rather than disappears, including the conservative refusal of any nonempty legacy token-only
tombstone table. Current-format migration is a byte-preserving no-op. See [migration.md](migration.md)
for the deliberately lossy metadata policy, source-preserving refusal and filesystem requirements.
Updating a package does not migrate files or install a new runtime.

## Deliberate migration breaks

The independent `createSquareApplication` API, its options/results/aliases, and `square-application.ts`
are deleted. Consumers must open/close an actual Square and select a Participant. SDK joins must use
`(await square.join(name)).participant`; history callers must use `.activities` and opt into full
archive reads with `limit: null`. SDK express now waits by default. MCP constructor configuration
uses `path`, consistent with `Square.at`, rather than `squarePath`.

External consumers must migrate before taking this source version. Editing source does not update
an installed plugin, build, or running extension.
