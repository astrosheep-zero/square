# One Square application boundary

**Status: implemented; deliverer verification and measurement are recorded in the delivery evidence. Independent review remains separate.**
Baseline: `52b58eb9f901f0458302e6120cd83b1079f8ba1c`. Delivery evidence and the exact size recipe live in [application-facade-delivery-evidence](application-facade-delivery-evidence.md).

## Decision in brief

- `square-application.ts` is the sole runtime application owner. It captures the operation context, resolves location/participant, opens and closes resources, applies common defaults (reentry, quiet-wait, default wake transport, history page size), coordinates private actions, and composes projections.
- `square-facade.ts` stays type-only: it declares the operation contracts, the `{data, projection}` outcome, projection contracts and the SDK resource types. It is the source of every public contract name; the owner re-exports its types.
- CLI and MCP are transport adapters. Neither opens storage, reads private projections, executes admission/wait policy nor derives domain states from display text.
- SDK resource handles and the application share the same semantic owners (`prepareExpression`, `landExpression`, `catchOwned`); the handles do not round-trip through the application outcome/projection contract.
- `square-wiring.ts`, root `activity.ts` and root `watch.ts` are deleted. No forwarding stub, legacy factory or return-shape mode remains.
- The SDK resource API and its documented defaults are preserved, but they are a resource surface over the same owner functions, not a second implementation.

## The application contract

Root factory (named, single):

```ts
export function createSquareApplication(context: SquareApplicationContext): SquareApplication;
```

Context (`cwd`, captured `env`, optional `squarePath`, `participant`, `clock`, `hostLedger`, `wakeTransport`) is snapshotted at creation. Location resolution uses the context and its `SQUARE_LOCATION`; participant selection is explicit context, then captured `SQUARE_PARTICIPANT_NAME`, then one unambiguous current-session binding from the selected/injected ledger. Explicit values win. A history read never discovers, joins or claims a participant just to select a default limit.

Every operation returns one composed outcome:

```ts
export interface ApplicationOutcome<Data, Projection> {
  readonly data: Data;       // canonical structured result (the MCP wire fields are a subset)
  readonly projection: Projection; // extra domain/presentation facts, never terminal copy
}
```

`SquareApplication` exposes `now()`, `build`, `join`, `express`, `catch`, `history`, `listen`, `ignore`, `listening`, `hold`, `resume`, `done`, `status`, `participants`, `diagnose`, `migrate`, `discover`, `inbox`, `recovery` and `stream(options, control?)` (an abortable `AsyncIterable`, not a process writer). Read-only operations accept the same `OperationControl` (`signal` + typed progress).

This outcome contract **replaces** the previous factory return values; it is not source-compatible with them, and it does not select semantics or shapes by transport. In-repo consumers migrate together. There is no second factory, no overload that chooses a return shape, and no compatibility shim. The application result contract is recorded in the delivery evidence so it cannot be mistaken for the earlier factory contract.

Array-bearing results use object envelopes (`{activities}`, `{participants}`, `{listening}`), never arrays carrying hidden metadata. `data` never contains an artifact, transaction callback, SQL, lock or lease capability.

`ApplicationFailureDetail` supplements, never contradicts, authoritative `facts.activityUnsent`; the owner classifies express effects as before-attempt, proven-unsent (authoritative admission refusal), landed (committed activity + ID) or unknown (execution failure without refusal/result evidence).

## Committed facts and projection sources

- Express takes its minimal count/header facts from the authoritative commit's own observation. It does not issue a later context read that could erase a successful say, and it does not build a second pending feed that would be discarded. The outcome `data` is the committed activity, `waited` and optional `replyAuthorNotHere`; the projection adds the pre-attempt directed feed, the reentry fact and delivery.
- Catch settles raw records, say ordinals and count/terminal facts inside the same receipt transaction as selection and marking seen. There is no duplicate post-receipt raw re-read: the application outcome adds the optional focused `catchPresence` read instead, and its unavailability is an explicit fact (`enrichmentUnavailable`).

## SDK resources and preserved defaults

- `Square` and its participant handles live in `square-application.ts`; `index.ts` exports `Square` from there, not from a forwarding shim.
- SDK handles call the shared semantic owners directly, not through an application outcome/projection roundtrip:
  - `Participant.express` = `prepareExpression` (reentry/caller resolution) + the shared `landExpression` retry/commit owner. It returns the established `ExpressResult` (including `delivery`) and drops the projection.
  - `Participant.catch` = the shared `catchOwned` lease/wait/selection/sweep owner. It unwraps the receipt data into `CatchResult` (`activities`, `consumedThrough`, `idleExpired`, `remaining`).
  - Listener, lifecycle and history methods call their shared owners directly; `snapshot().delivered` stays a detached receipt predicate.
- Retained supported `Square` methods: `at`, `build`, `inMemory`, `join`, `takeover`, `doneOwnedSession`, `implicitJoin`, `participants`, `snapshot`, `history`, `recognize`, `close`, `endOwnedSession`, `retireEndedSessionRoutes`. The unused `joinWithActivity`, `takeoverWithActivity`, `joinFacts` and `standingCount` glue is deleted.
- Preserved defaults are explicit at the SDK/application boundary, not a difference in transport defaults:
  - `Square.history()` keeps its current **unbounded** archive default.
  - `Participant.history()` keeps its current **recent-ten** default.
  - Application, CLI and MCP ordinary history default to **ten**, independent of participant selection.
- In-memory resources stay in-memory: they do not invent file/native wake routes or build a default transport merely to express.

## Module deletion map

| Path | New ownership | Disposition |
| --- | --- | --- |
| `square-wiring.ts` | `square-application.ts` | **Deleted.** `Square`/participant handles flattened into the owner; no re-export stub. |
| `activity.ts` | `app.express` + `cli/express-presentation.ts` | **Deleted.** Caller resolution, implicit join, attempt/uncertainty policy and default-transport construction moved to the owner; only draft/retry/render helpers survive in the CLI. |
| `watch.ts` | `app.catch` + `cli/catch-presentation.ts` | **Deleted.** Lease/heartbeat/revision loop and terminal policy moved to the owner; one renderer of returned classifications remains. |
| `square-application.ts` | — | **Owner.** Shared `prepareExpression`/`landExpression`/`catchOwned` semantic owners are the single implementation for application and SDK. No application -> SDK -> application chain; unused SDK glue (`joinWithActivity`, `takeoverWithActivity`, `joinFacts`, `standingCount`) deleted, supported methods retained. |
| `square-facade.ts` | — | Type-only contracts, `ApplicationOutcome`, projection/SDK contracts, explicit legacy name aliases. |
| `square-actions.ts` | `square-actions.ts` | Private mutation/ownership fences/delivery integration; called only by the owner. |
| `decisions.ts`, `catch-decisions.ts`, `wakes.ts` | unchanged files | Private implementations used by the owner. |
| `views.ts` | unchanged file | Private selected-row reads. `activityPresentation`, `standingCount`, `joinFacts` and `watchPresentation` retired; focused `recoveryObservation` and `catchPresence` added. Public projection types live in the facade. |
| `list.ts`, `stream.ts` | unchanged files | Internal data-returning discovery/observation; no process writers or argv recovery. |
| CLI operation paths (build, join, express, catch, history, listen/ignore/listening, hold/resume/done, status, participants, inbox, discover, doctor, migrate) | corresponding `app.*` | Direct storage opens, private projection imports, admission policy and duplicated wait loops removed. |
| `mcp.ts` | `app.*` | `publicResult`/stored-activity conversion deleted; serialize `outcome.data` only. |
| `index.ts` | owner + facade | Root `Square` from the owner; all facade contracts via one type-only star plus the supported legacy aliases. |
| `automatic-session.ts`, `claude-mod.ts`, `plugins/opencode/index.ts` | owner | Mechanical import migration only; native lifecycle protocols unchanged. |

## Architecture edges

- **Adapter boundary.** CLI/MCP reach storage, actions, decisions, views, wakes, list, stream, diagnosis/migration, inbox and notification execution only through `square-application.ts`. Private concern helpers retain their existing typed ports and internal dependencies; they are not callable from adapter execution paths.
- **Facade.** `square-facade.ts` defines contracts; it must not derive contracts from `ReturnType`/`Awaited<ReturnType>` of private functions, and public activity IDs are formatted/parsed only by the existing core implementation.
- **CLI (`cli/**`).** Owns argv/stdin, scoped help, shell quoting, sensory rendering/recovery, drafts, stdout/stderr, exit codes, SIGINT -> `AbortSignal` and stream backpressure. It maps returned classifications to copy/exit status, and preserves query argv in continuation commands; it cannot derive admission, commit certainty, terminal states or pagination eligibility from display text. File path display and draft-file I/O are allowed; opening an artifact or resolving ownership is not path formatting.
- **MCP (`mcp.ts`).** Owns Zod schemas, registration, request-local `as`/`_meta.threadId`/session mapping, signal forwarding, JSON-RPC envelopes and stdio lifecycle. Request environment derivation stays immutable; no shared `process.env` writes and no invented session identity. Its method-name dispatch is a thin argument-to-method mapping, not a second policy dispatcher.
- **Closed exceptions.** Harness install/uninstall/doctor, scoped help/version, meta commands and native hook input/output keep their existing protocol owners; that exception does not cover join, expression, catch, history, status, participants, build, stream, discovery, inbox, artifact doctor or migrate. Native changes stay limited to the required owner import migration.
- **Storage/native scope.** SQLite schema/framing, artifact version, migration protocol, receipt model, ownership CAS, notification cancellation suppression and delivery eligibility rules are unchanged. Transactions stay synchronous and typed. The journaled amendment permits only build/create signal propagation through the existing adapter/storage/artifact retries and transactions, and captured-env propagation through default Codex wake construction/executable selection. A committed build is returned despite later cancellation; temporary-file cleanup does not reuse the aborted signal.

## Shared behavior (all four land together)

1. Application express reenters a roster-known departed participant through the same join/ownership path; a never-joined caller is refused. Takeover is never implicit.
2. Application idle catch is one shared leased quiet wait (hold/heartbeat/replacement/terminal); omitted/zero idle is immediate; exact `id` stays immediate/idempotent and conflicts with idle/filter/limit/replace; a non-replaced current lease returns `already-active`.
3. The default wake transport resolves lazily from the captured env, selected/injected ledger and clock, cached only for that application's lifetime; an injected transport prevents default construction.
4. Application, CLI and MCP history default to ten; SDK `Square`/`Participant` defaults above are preserved.

Only these four deliberate common behavior changes, plus the additive explicit idle terminal statuses, alter existing behavior. All other SDK/CLI/MCP contracts, error codes and wire meanings are preserved.
