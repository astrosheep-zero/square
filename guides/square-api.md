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

const square = await Square.at({ path: './discussion.square', env: { ...process.env } });
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
  native wake transport.
- `Square.at` accepts `path`, optional `cwd`, captured `env`, `clock`, `hostLedger`, `wakeTransport`,
  `backends`, and default `participant`. The `backends` configuration selects explicit named stdio
  aliases. Paths resolve against `cwd`;
  `stdio://name/key` stays a canonical URI and routes before filesystem access. An omitted path uses
  captured `SQUARE_LOCATION`. Explicit participant, configured default, nonblank captured `SQUARE_PARTICIPANT_NAME`,
  then an unambiguous current-session ledger binding determine a name, in that order.
- `await square.participant(name?)` selects a handle **without joining, claiming or reentering**.
  Discovery happens on each selection, not through a cached session-to-name decision.
- `square.join(name?, options?, control?)` returns one `JoinResult`: `{participant, activity, kind,
  participantCount, observation?}`. `participant` is a handle, not a string. `takeover: true` reclaims
  a standing name; fresh/departed names join normally. There is no separate `Participant.join()`
  or public `takeover()` API. `participantCount` counts known joined-or-done names.
- A Square owns its connection unless `resources: createSquareResourceOwner()` lends it one.
  Closing a borrowing handle leaves that owner open. Request signals never become the borrowed
  connection's lifetime. The MCP server drains cancelled/in-flight work before closing its owner;
  explicit location overrides get independent request-owned connections. Stdio opens always own
  their process connection (SQLite resource lending does not pool remote processes).

## One set of operations and defaults

Square owns `history`, `status`, `participants`, `snapshot`, `stream`, and recovery observations.
Participant owns `express`, `catch`, `listen`, `unlisten`, `ignore`, `listening`, `hold`, `resume`, `done`;
its `history` delegates to the same Square history operation.

- Express waits while held/throttled unless `noWait: true`, for **every** caller. `ExpressResult`
  includes the committed `activity`, `waited`, optional `delivery`, and landing-time warnings
  (`unmatchedMentions`, `replyAuthorNotHere`). Warnings are not stored on the activity.
- Catch returns `{activities, consumedThrough, remaining, idleExpired, status?, observation?}`.
  Omitted/zero idle is immediate; positive idle uses the single leased quiet wait. Receipt selection,
  ordinals, counts and terminal facts settle in the receipt transaction. Cancellation/replacement
  releases only that waiter's lease and never consumes future activity.
- All history callers return a `HistoryResult` object with `activities`. Default page size is ten;
  `limit: null` explicitly requests an unbounded archive. Numeric limits must be 1–100. Contextual
  queries still reject an implicit merged window over 100 activities; an explicit numeric limit
  bounds it. CLI/tool schemas accept numeric limits only. History never writes receipts.
- `participants()` returns `{participants, observation?}` and `listening()` returns
  `{listening, observation?}`, not arrays carrying metadata.
- `unlisten(target)` removes only that participant's current listen edge to the target, without
  leaving or blocking future mentions/replies. It returns the same `ListenerChangeResult` as listen
  and ignore, with `activity: null` when no listen exists. Existing ignores are unchanged. Earlier
  landed audiences and receipts are never rewritten; listening again remains available.
- Lifecycle operations keep contextual reentry/ownership policy. In particular, done retains its
  native owner epoch fence instead of blindly joining first. Done accepts no message.

Every operation accepts its final `OperationControl` (`signal`, optional typed `onProgress`).
Listener/lifecycle operations take optional observation options before that control argument.

## Optional observations, not another execution path

Request `observe: true` on the **same method** when rendering needs additional facts. Each operation
has a concrete optional observation type, without conditional generics or a generic outcome wrapper.
Data-only calls do not hydrate join history, the pre-expression feed, catch presence enrichment,
or history/status presentation annotations.

Express captures its optional directed feed before the attempt and returns count/held/time facts
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
actions, storage, admission, scanners or query execution. MCP/Pi use the shared `square-tools.ts`
definitions. Join JSON contains `participant.name` and the receipt fields, never the handle or its
resources. Express wire output omits the internal delivery diagnostic as before.

`discover(input, options?, control?)`, `inbox(input, sessionId, options?, control?)`,
`diagnoseSquare(input, control?)`, and `migrateSquare(input, control?)` are ordinary public exports.
They are not methods on a synthetic cross-square object. Diagnose/migrate resolve a path without
opening a valid current-format Square first.

## Artifact format and explicit migration

The current artifact format is 3. It records `unlisten` as a real history activity; the derived
attention table still contains only listen or ignore edges. New artifacts use format 3. Ordinary
opens refuse older formats with migration guidance, and never migrate implicitly.

Stop all sessions and services using a particular artifact, back it up offline (or use SQLite's
backup API), then run `square --location <path.square> migrate` and `doctor` before reopening it
with upgraded runtimes. Older runtimes refuse format 3; do not mix versions against a migrated
artifact. Updating a package does not migrate any file.

Format 2 migration changes only the activities table's accepted event kinds and the format marker,
inside one transaction. Existing rows, revision, assigned indices, attention, landed audiences,
receipts, leases, and routes remain unchanged. Format 1 snapshots import directly into the current
format. Repeated migration of a current artifact is a byte-preserving no-op. This is separate from
host-ledger migration, whose format does not change for unlisten.

## Deliberate migration breaks

The independent `createSquareApplication` API, its options/results/aliases, and `square-application.ts`
are deleted. Consumers must open/close an actual Square and select a Participant. SDK joins must use
`(await square.join(name)).participant`; history callers must use `.activities` and opt into full
archive reads with `limit: null`. SDK express now waits by default. MCP constructor configuration
uses `path`, consistent with `Square.at`, rather than `squarePath`.

External consumers must migrate before taking this source version. Editing source does not update
an installed plugin, build, or running extension.
