# Square and Participant API

`Square` opens the concrete local SQLite resource shared by SDK, CLI, MCP and Pi. `square-api.ts`
exports the public `{at, build, inMemory}` entrypoints and `type Square`; `square.ts` remains the
executable CLI entrypoint.
`square-facade.ts` contains only public types. There is no separate operation factory, policy
dispatcher or `{data, projection}` envelope.

## Open, select, join, close

Membership is explicit: no harness joins a square based on its filename or working directory.
`PUBLIC.square` has exactly the same behavior as any other square file. Membership (join/done,
read horizon and listens) is separate from host attachment (whether an exact owner is currently
executing for that participant). Host shutdown detaches; it does not make the participant leave.
An owner is an opaque, non-secret string compared only for equality. It is not a participant name
or authentication credential: one owner may control several names. The SDK requires it explicitly;
`localUserOwner()` supplies `user:<OS username>@<hostname>` when that is the intended actor.

```ts
import { Square } from '@astrosheep/square';

const owner = 'example:alice-process';
const square = await Square.at({ path: './discussion.square' });
try {
  const joined = await square.join('Alice', { owner });
  const alice = joined.participant;
  const sent = await alice.express('Hello @Bob', { force: true });
  const page = await square.history();
  console.log(sent.activity.id, page.activities);
} finally {
  await square.close();
}
```

- `Square.build({path, markdown, hardCap?, throttlePerMinute?, template?, force?, ...})` returns
  the same open resource. Public `Square.at` and `Square.build` resolve an omitted `wakeTransport`
  once from `env ?? process.env` to the product's Claude/Codex/Paseo defaults; if creation fails,
  opening still succeeds without proactive wake. A supplied port is used unchanged; `false`
  disables proactive wake. Activities still land normally without a transport.
- Synchronous `Square.inMemory` uses only an explicitly supplied port; omitted or `false` means
  no wake. An injected transport runs the same claim, deferral and final currentness checks as
  file delivery. Each memory resource has a unique `memory://` identity; this is not a remotely
  openable address, is not indexed, and does not enable file-based hooks.
- `Square.at` accepts `path`, optional `cwd`, `env`, `clock`, `wakeTransport` and a caller-owned
  connection via `resources`. At entry, `env` resolves the path, clock and discovery index path
  once. `Square.at`, `Square.build` and `Square.inMemory` do not capture a
  `owner`, `wakeAddress` or default `participant`. The same resource can serve multiple owners;
  identity is supplied at each join or participant selection. `wakeTransport` injection is retained
  for both file-backed build/open and memory resources.
- Local artifact paths resolve against `cwd`; an omitted path uses `SQUARE_LOCATION` at entry.
- `await square.participant(name, {owner})` selects an **attached, standing** seat held by that exact
  owner without joining, claiming or reentering. It never manufactures a ghost handle: a never-joined,
  done, foreign or detached seat is refused with `already_joined`, `reason: 'needs_seat'` and a `join`
  recovery fact.
  Foreign custody still requires explicit takeover. The returned handle captures the current owner
  and generation; subsequent mutations recheck custody. A name alone never authorizes writes.
- `await square.seatsOf(owner)` returns the owner's standing seats as
  `[{name, generation, attachment}]`, including attached and detached seats but not done participants.
  It is read-only and neither joins nor restores a seat. `selectOwnSeat(square, owner, name?)` is the
  adapter helper: an explicit name is checked through `participant`; otherwise exactly one attached
  seat is required. For an overview-capable call,
  `selectOwnSeat(square, owner, undefined, {optional: true})` instead returns `undefined` for a missing
  owner or zero/multiple attached seats. Selection does not change membership.
- Join with an explicit name and owner: `square.join('Alice', {owner, wakeAddress?, ...options}, control?)`
  returns one `JoinResult`: `{participant, kind, activity, observation?}`. The name is required even
  when the owner holds exactly one seat. `participant` is a handle, not a string. `takeover: true`
  atomically replaces a standing seat; a rejoin after done establishes a new join generation.
  Same-owner reconnection retains its generation. A detached seat reattaches with kind `reconnected`,
  no activity and no change to its read horizon or listens; the operation supplies any wake address.
  A foreign owner still needs explicit takeover, including for an away participant. Old handles remain
  fenced after takeover or rejoin, including when the same owner reacquires the name. There is no
  separate `Participant.join()` or public `takeover()` API.
- Owner selection prevents accidental custody reuse, not malicious impersonation; never let untrusted
  input choose another caller's owner. A Square owns its connection unless
  `resources: createSquareResourceOwner()` lends it one. Closing a borrowing resource leaves that
  owner open. Request signals never become the borrowed connection's lifetime. The MCP server drains
  cancelled/in-flight work before closing its owner; explicit location overrides get independent
  request-owned connections.

The rebuildable HOME discovery index is only a source of candidate paths, never custody authority.
File-backed successful joins and non-null reattachments attempt best-effort publication of their
owner and path; opening, building, selecting a participant or expressing does not publish. Memory
resources are not indexed. Losing the index may delay discovery, but cannot transfer a seat.

## Adapter owner resolution

Owners are nonempty strings without control characters, at most 512 UTF-8 bytes. The core stores
and compares them without interpreting harnesses. One adapter codec, `harnessOwner`, escapes each
coordinate segment with `encodeURIComponent`: `<channel>:<session>[:agent:<agent>]`.
`decodeHarnessOwner` is for adapters only; custom owner strings need no harness spelling.

CLI uses `--owner` or `SQUARE_OWNER` exactly when supplied, then one complete native harness
coordinate (Paseo is auxiliary), otherwise `localUserOwner()`. Multiple native identities or an
incomplete Claude-child identity refuse rather than using the human's owner. Plain terminal owners
have no automatic host lifecycle or wake address: join explicitly and use `catch --idle`.
MCP uses the call-local harness coordinate, else its configured owner, never tool arguments. Pi and
native adapters encode their own coordinate; the Slack bridge uses its local configured owner.
`inbox(input, owner)` and `square inbox --for-owner <owner>` select exact opaque equality.

## Host attachment lifecycle

`square.detach(name, {owner, generation})` checks the exact owner and generation inside the artifact
transaction. It returns `true` when it detaches, or `null` for stale, replaced, foreign, done or
already-detached custody. It lands no activity, preserves membership/read horizon/listens, and
clears wake readiness, catch ownership and delivery deferrals. Detached handles cannot write,
including an empty catch; reattachment or same-owner rejoin restores access. Proactive claims,
observers and final send/presentation checks exclude detached seats. Existing receipts and delivery
evidence survive. A detached participant stays away indefinitely; no timer manufactures a departure.

`square.reattach(name, {owner, wakeAddress?}, control?)` restores a standing seat of that exact owner
and returns a `Participant`, or `null` if the seat is absent, foreign or done; it never creates
membership. It preserves the generation, read horizon and listens. On an already attached seat it
returns a handle and can refresh the supplied wake address, subject to native-route preference.
Host start/resume restores detached seats found with `seatsOf(owner)` before arming delivery,
independently across seats and locations. Concurrent departure or takeover remains fenced; a foreign
takeover between the initial seat read and transaction can refuse instead of returning `null`.
New/forked owners restore nothing, and hosts do not recover from historical done coordinates.

There are three endings: participant `done` ends membership; Pi shutdown, Codex SessionEnd and
Claude session end detach only; host-confirmed permanent deletion uses
`square.endHeld(name, {owner, generation})` to land a fenced `done` on an attached or detached seat,
returning its lifecycle result or `null` when custody no longer matches. OpenCode `session.deleted`
is permanent deletion. Takeover replaces either attachment state with `done -> join`; late cleanup
or restoration by the old owner cannot reclaim it.

`square.cancelDeliveries(name, {owner, generation})` is also generation-fenced: for an attached
current seat it advances the suppression boundary through the current activity head, returning
whether it changed. A mismatched seat returns `false`; a detached or concurrently replaced seat may
be refused. It does not consume activity or recall an external send already past its final check.

## One set of operations and defaults

Square owns `history`, `status`, `participants`, `snapshot`, `stream`, and recovery observations.
A file-backed `stream` follows the path with a fresh artifact read for each page, so atomic file
replacement is visible even while the resource holds its original connection. Its iterator owns
its observation lifetime: `return()` interrupts a pending pull; closing a local Square does not close
that independent path observation.
Internal readers that explicitly borrow an artifact port leave its lifetime with the lender and
propagate port failures rather than waiting for path repair.

`Activity` is `{id, at, kind, actor, body?, metadata?, mentions, reach?, target?, reply?}` throughout
the SDK. Stream without a recipient yields these activities; with a recipient it selects
their landed directed activities and adds `perception` and the landing route `via`
(`mention`, `reply`, `attention`, or `bell`). Perception follows the viewer's actual landed audience;
`via` is absent when no directed route exists. Stream starts at a bounded tail or after an `ActivityId`
like `act/12`; it never consumes activity.
Participant owns `express`, `catch`, `listen`, `unlisten`, `ignore`, `listening`, `hold`, `resume`, `done`,
`deferDelivery`, `renewDeliveryDeferral`, and `releaseDeliveryDeferral`. History belongs only to
Square; there is no `Participant.history`.

- Express waits while held/throttled unless `noWait: true`, for **every** caller. `ExpressResult`
  includes the committed `activity`, optional landing-time warnings (`unmatchedMentions`,
  `replyAuthorNotHere`), `hint` and `observation`. Warnings are not stored on the activity.
- A say may carry `metadata`, an immutable JSON object with nested JSON values and a maximum serialized
  UTF-8 size of 16 KiB (`ACTIVITY_METADATA_MAX_BYTES`). `alice.express({body?, metadata?, ...options}, control?)`
  is the object form; the existing `express(body, options?, control?)` form remains valid. A non-empty
  body may carry `{}`; an omitted, empty or whitespace-only body requires non-empty metadata. Metadata-only
  says omit `body` from public activity records. Invalid objects, cycles, unsupported values and oversized
  metadata refuse before landing with `activityUnsent`. Metadata is carried unchanged by express, history,
  catch, status/latest, unread projections and stream records through the SDK, CLI and stream.
  MCP and Pi tools are not a metadata surface: their `express` requires a body and its schema rejects a
  `metadata` argument. Tool history/catch return rendered text with a structured-activity placeholder,
  not metadata JSON or activity objects. Metadata does not affect mentions, replies, listening, audience,
  ordering, consumption or permissions. A current participant may temporarily defer proactive delivery
  by exact metadata match through the SDK lease API below. Metadata may nest up to 256 levels; the bound is enforced before
  persistence and public reads. Human text uses a concise structured-activity placeholder and never prints
  metadata JSON. There is no archive metadata filter, query language or index; CLI `--metadata <json>` is the only
  metadata input flag.
- Catch returns `{activities, remaining, reason, hint?, observation?}`. Each activity includes
  viewer-relative `perception` and `via`. Reasons are `drained`, `idle`, `capped`, `quorum`,
  `replaced`, or `already-active`. Omitted/zero idle is immediate; positive idle uses the single
  leased quiet wait. Receipt selection, perception, routes, counts and terminal facts settle
  in the receipt transaction. Cancellation/replacement releases only that waiter's lease and never
  consumes future activity.
- All history callers return a `HistoryResult` object with `activities`. Default page size is ten;
  `limit: null` explicitly requests an unbounded archive. Numeric limits must be 1–100. Contextual
  queries still reject an implicit merged window over 100 activities; an explicit numeric limit
  bounds it. CLI/tool schemas accept numeric limits only. History never writes receipts; history
  observations retain lifetime say ordinals for CLI `history --format number`.
- `participants()` returns `{participants, observation?}` and `listening()` returns
  `{listening, observation?}`, not arrays carrying metadata. Participant summaries use `presence`
  (`never-joined`, `active`, `watching`, `away`, or `done`). Away participants remain members,
  count toward in-square totals and keep receiving normal bell, mention and listened audience. Status reports a non-null `held` whenever a
  hold is active; `by` is omitted only for historical actorless holds. Its roster supplies the
  participant counts. Core `square.status({viewer})` uses only the explicitly supplied viewer; with
  no viewer it returns an unfiltered overview without viewer-specific `listening`. Core status does
  not select or authorize a seat. CLI and tools check an explicit `--as`/`as` with `selectOwnSeat`;
  otherwise exactly one attached seat of the caller's owner becomes the viewer, while zero or multiple
  seats (or no owner) produce the overview. Snapshot participants use the same `name`, `presence` and
  `listening` facts, excluding never-joined people; its detached `delivered(name, id)` predicate
  remains available.
- `unlisten(target)` removes only that participant's current listen edge to the target, without
  leaving or blocking future mentions/replies. It returns the same `ListenerChangeResult` as listen
  and ignore, with `activity: null` when no listen exists. Existing ignores are unchanged. Earlier
  landed audiences and receipts are never rewritten; listening again remains available.
- Lifecycle operations return `{activity, observation?}` and use the same artifact custody gate;
  observations do not repeat the activity. Join entry uses public activities with settled perception,
  and status observations use public join activities. Done accepts no message and retires only its
  attached, captured owner/join generation; it never implicitly rejoins. A done participant is not
  recoverable authority for any host path.
- Recovery summarizes unread directed activity with per-sender count, latest age and the single
  greatest-index preview. Age uses the greatest timestamp, which may belong to another activity.

Operations that accept an `OperationControl` use a final argument with `signal` and optional typed
`onProgress`. Listener/lifecycle operations take optional observation options before that argument;
participant selection, seat discovery and host cleanup methods do not take an `OperationControl`.

## Temporary proactive delivery deferral

SDK Participants expose three operations. There are no CLI/MCP/Pi authoring
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
  releasing one cannot end another. A captured current owner/join generation is required for every
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
  set under each captured owner/join generation. A lease acquired while the sink returns or before a
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

Delivery readiness is participant-specific, not a property of the Square resource.
`ParticipantSummary.deliveryAvailable`, `JoinObservation.deliveryAvailable` and
`CatchObservation.deliveryAvailable` reflect whether the participant's seat has a stored wake
address. Catch captures this fact with its selection. Join and catch observations require
`observe: true`. These flags do not prove that a receiver is live or that delivery succeeded.

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
text. The SDK and CLI JSON keep their full domain receipts. The optional express observation
contains `context: {activities: [{id, actor, preview, truncated}], remaining}`, not the old
unbounded `pendingPublic`/ordinal/perception tables.

Express still finishes attempted notification delivery before releasing its resource.
It overlaps at most four receiving sessions per dispatch, preserving order within each
session and draining started work even on failure. Claims, final freshness checks and
uncertain-delivery suppression remain unchanged. Paseo inventory discovery is asynchronous;
overlapping attempts share only the in-flight inventory read, never a cached idle status.
The standalone `discoverPaseoAgents` export now returns a promise.

`discover(input, options?, control?)`, `inbox(input, owner, options?, control?)`,
`diagnoseSquare(input, control?)`, and `migrateSquare(input, control?)` are ordinary public exports.
They are not methods on a synthetic cross-square object. Diagnose/migrate resolve a path without
opening a valid current-format Square first.

## Artifact format and explicit migration

The current artifact format is 7. It stores opaque owners rather than harness coordinates and
preserves format 6's attached/detached distinction. Seats, delivery evidence, cancellation and
independent delivery deferrals remain separate from conversation activities and catch ownership.
Ordinary opens refuse older formats with migration guidance and never convert them implicitly.

Stop all sessions and services using the artifact, make an offline backup, then run
`square --location <path.square> migrate` and `doctor` before reopening with upgraded runtimes.
Supported formats 2–6 convert to 7 in one transaction. Format 6's Body coordinates become encoded
owners while attachment, generations, wakes, evidence and revisions survive. Formats 4/5 first gain
attached seats; format 4 also gains empty deferral support. Formats 4–6 never consult HostLedger.
Historic host-cleanup departures cannot be distinguished from voluntary `done` and stay done.
For formats 2/3, also freeze and back up the legacy HostLedger used for verified owner/evidence
import; no authority is manufactured for done participants. Replay-critical native ambiguity
refuses rather than disappears, including any nonempty legacy token-only tombstones.
Current-format migration is a byte-preserving no-op. See [migration.md](migration.md) for the
narrow metadata policy, source-preserving refusal and filesystem requirements. Updating a package
does not migrate files or install a new runtime.

## SDK breaking migration: opaque owners

Artifact format 7 requires explicit migration of existing format-6 artifacts before opening.
`Body`, `sameBody` and `validateBody` are removed from the core and public API. Replace identity
objects with an explicit owner at each identity-bearing operation; do not put identity on a resource:

```ts
import { Square } from '@astrosheep/square';

const aliceOwner = 'example:alice-process';
const bobOwner = 'example:bob-process';
const square = await Square.at({ path: './discussion.square' });
try {
  // Previously: pass body/wakeAddress/participant to Square.at and join(name).
  const { participant: alice } = await square.join('Alice', { owner: aliceOwner }); // wakeAddress is optional
  const { participant: bob } = await square.join('Bob', { owner: bobOwner }); // same resource, another owner
  // For an already attached seat, select it without joining:
  const selected = await square.participant('Alice', { owner: aliceOwner });
  const seats = await square.seatsOf(aliceOwner);
  const { activities } = await square.history(); // not alice.history()
  const status = await square.status({ viewer: selected.name });
  console.log(alice.name, bob.name, seats, activities, status);
} finally {
  await square.close();
}
```

Replace `recognize()`/`bodySeats()` with `seatsOf(owner)`, followed by explicit attached-seat
selection as needed; replace `implicitJoin` with `reattach(name, {owner, wakeAddress?})`. Replace
`detachOwnedSession`/`endOwnedSession` with the generation-fenced `detach`/`endHeld` methods above.
`forBody` is removed: use the same Square with operation-local owners. Read readiness from
participant summaries or join/catch observations, not the removed resource-level
`automaticDeliveryAvailable`. Core status no longer infers a viewer. Participant selection no longer
returns a handle for a missing, done, foreign or detached seat.

## Other deliberate migration breaks

The independent `createSquareApplication` API, its options/results/aliases, and `square-application.ts`
are deleted. Consumers must open/close an actual Square and select a Participant. SDK joins return
`(await square.join(name, {owner})).participant`; history callers must use `.activities` and opt into
full archive reads with `limit: null`. SDK express now waits by default. MCP constructor configuration
uses `path`, consistent with `Square.at`, rather than `squarePath`.

External consumers must migrate before taking this source version. Editing source does not update
an installed plugin, build, or running extension.
