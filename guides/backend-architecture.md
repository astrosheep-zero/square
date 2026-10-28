# Extensible operation backends — architecture correction

Status: settled implementation design for the corrected scope, including preservation of current native previews and presentation receipts. Implementation and independent review remain required.

## Outcome

Square exposes one Square/Participant operation API. An independently supplied backend can implement that API and participate through SDK, CLI, MCP and Pi without adding a backend branch to those callers or modifying the shared resolver. SQLite and stdio are built-in implementations. Slack is a design example, not an instruction to provision Apps or implement a live Slack integration.

The existing stdio client/server remains useful. Its successful tests do not establish this architecture: `square-api.ts` currently selects local or stdio directly, and `SquareBackend` inherits every public member of `SqliteSquare`, including local host methods.

## Ownership

| Concern | Owner |
| --- | --- |
| Square/Participant operation signatures and result types | Public resource contract, independent of any implementation |
| Selecting an implementation from a location | Shared backend resolver |
| Parsing and canonicalizing a backend's address | That backend |
| Participant to backend principal/credentials mapping | That backend's trusted configuration |
| Current harness session identity | Harness adapter, captured separately for each call |
| Durable membership, pending attention and catch receipts | Backend owning that square |
| Binding a participant to a local agent session | Host integration; an optional backend host capability, with ownership checked by the backend |
| Delivering awareness to the current agent session | Existing harness delivery adapters |
| Local SQLite artifact, transactions, native ownership evidence | SQLite implementation |

Neither `location` nor a participant name is an executable, a secret, or authorization by itself.

## Public resource contract

Declare the Square resource interface directly using the operation/result types in `square-facade.ts`. It contains `location`, `participant`, `join`, `history`, `status`, `participants`, `recovery` and `close`. Participant operations remain the existing typed methods. Do not derive this contract from `SqliteSquare`, add an untyped operation dispatcher, or wrap results in a second generic result envelope.

Local host operations (`recognize`, `implicitJoin`, `doneOwnedSession`, `endOwnedSession`, `retireEndedSessionRoutes`) are not requirements on every backend. Put them behind the optional host capability described below. The existing SQLite implementation can satisfy that capability using its current ownership and epoch logic.

Snapshot and stream are separate read capabilities, not prerequisites for participation. The bundled SQLite and stdio backends support streaming; unsupported operations fail before mutation. Local file doctor, migrate and filesystem discovery stay local utilities and do not become mandatory backend methods.

A backend must return the documented concrete operation results, including requested observations used by current rendering. It may reject a genuinely unavailable operation explicitly. It must not fabricate history, receipts, atomicity, membership or successful mutations to satisfy a type.

## Driver and configuration boundary

A driver is the constructor/resolver for resource handles; a handle is an opened square. Keep these distinct.

Each driver declares one URI scheme and provides:

- `resolve(location, context)`: validates its own location grammar and returns the canonical location. This operation does not send messages or create the square.
- `open(resolved, context, control)`: opens an existing resource.
- Optional `build(resolved, creation, context, control)`: explicitly creates a resource; absent means build is unsupported.

Context contains backend-specific trusted settings, captured working directory/environment, the requested default participant, and the current call's harness identity. Identity extraction uses the existing harness coordinate functions; it never overwrites a process environment variable or treats backend process startup identity as the caller. Local clock/artifact/ledger injection remains an SQLite construction option, not a wire requirement on every driver.

Use one driver registry, scoped to the caller's captured configuration. Built-in SQLite handles ordinary paths; built-in stdio owns `stdio:`. SDK callers may provide driver objects. CLI/MCP/Pi load the same configured ESM driver exports from trusted local configuration; no module path, command or secret is loaded from a location or tool argument. Do not create a process-global mutable registry.

Backend configuration is indexed by scheme. Each entry chooses an installed driver module where needed and supplies opaque settings for that driver to validate. Stdio connection aliases and their commands are settings of the stdio driver, not the universal configuration schema. Replace the current command-only `SquareBackends` shape and examples rather than keeping two competing configuration formats.

The public resolver recognizes a URI scheme, selects a configured driver, and delegates address parsing. It must not enumerate Slack path segments, stdio keys or future backend grammars. Unknown/unconfigured schemes fail clearly. Plain paths retain normal filesystem resolution. Only local paths go through realpath/path canonicalization; remote canonical locations remain backend-owned strings.

## Location, principal and session

These three identities are independent:

| Input/fact | Meaning | Example |
| --- | --- | --- |
| Canonical location | Which square | `slack://T_WORKSPACE/C_CHANNEL/1780000000.000001` |
| Participant/backend principal | Who speaks and with which backend authority | `faye` maps to one Slack bot user and its token |
| Harness session binding | Which running agent receives awareness | Current Pi session or Paseo agent |

For `stdio://local-discussion/design`, the stdio driver interprets `local-discussion` as its configured connection and `design` as a square key. The shared resolver does not interpret either component. Independent processes share a square only if the backend's service or persistence makes them share it.

For Slack, the driver validates workspace/channel/thread, chooses the bot credentials bound to the requested participant, and converts participant mentions to native bot user mentions. A different participant can use a different App against the same location. Inbound native user/bot IDs identify backend principals; display names or unverified metadata do not establish ownership. Multiple Apps' duplicate event deliveries must converge on the same backend activity identity.

Explicit participant selection remains usable without automatic notification support. A supplied `as` never authorizes another bot's credentials or takes over a session binding by itself.

## Optional host integration and attention

The backend host capability owns session recognition, fenced lifecycle cleanup and pending attention observation. Its signatures use the public location, participant and call-local session identity, not an artifact handle or SQLite read/write transaction. Adapt existing SQLite host methods into this capability. Common tool operations do not depend on it.

For a backend supporting automatic attention, the capability provides a cancellable attention source, a read-only currentness check, a pending preview read, and a fenced presentation operation. An event is a hint to inspect current backend facts; it is not a receipt. The host routes by canonical location plus participant to the current session, checks binding generation and pending status before native delivery, and retains the existing bounded model preview and native human presentation. Wake acceptance alone does not mark seen. At the native presentation boundary, backend-owned presentation may commit receipt changes according to that backend's semantics. SQLite preserves today's behavior: successfully presented complete previews mark seen; clipped previews do not. Duplicate hints must not duplicate presentation or receipts.

Notification paths must use this capability instead of applying `canonicalPath`, `openSquare` or artifact reads to arbitrary backend locations. The current SQLite wake checks remain inside the SQLite adapter. Backend capabilities can internally reuse their authoritative persistence; do not introduce a second generic pending queue or membership ledger.

Backend ownership checks are authoritative. A local session binding helps route awareness but cannot guarantee exclusive ownership across machines. Cleanup from an old session must not remove a newer binding.

A backend with no host capability supports explicit participation and catch/history. It advertises automatic delivery as unavailable. Stdio need not gain push in this correction, but the driver boundary must allow an implementation that supports it. Host operations on a backend lacking the capability must return a clear unavailable result or refusal as appropriate; they must never fall through to local file storage.

## Semantic differences

Capability information must distinguish selective body visibility from shared visibility, strict from best-effort policy enforcement, and automatic awareness from explicit catch. Keep this small and tied to actual behavior; do not build a speculative feature catalog.

SQLite retains current selective perception and transaction guarantees. The bundled stdio server inherits those backend guarantees and offers explicit catch and stream without automatic wake delivery. A Slack thread has shared body visibility: mentions route attention, not confidentiality. Slack hold/cap/throttle may use the previously accepted best-effort behavior. No shared presentation or skill text may promise private bodies or SQLite atomicity for such a backend.

Activity IDs and history bounds remain the existing public contract. A backend requiring native IDs must own a stable translation rather than casting Slack timestamps into `act/N`. Its durable mapping strategy belongs to that backend implementation, not the resolver.

## Failure and lifetime

Each opened handle owns its resources until close, unless an explicit caller-owned resource owner is supplied for a supported driver. Module caching is not connection pooling. Cancellation and progress keep the existing typed control surface. No implicit reconnect, mutation retry or replay is introduced. A lost response after an express request may have been sent remains `unknown`; local validation before dispatch can report `unsent`.

Creation is explicit through build. Optional enrichment, notification failure or cancellation after a committed mutation cannot turn a committed result into apparent failure. Driver configuration errors identify the affected scheme without echoing credentials.

## Concrete interface and loading decisions

The following signatures fix the public boundary. Existing operation/result types retain their concrete meaning. Type names can be organized across modules, but implementations must not substitute an implementation-derived interface.

```ts
interface SquareResource {
  readonly location: string;
  readonly capabilities: SquareCapabilities;
  readonly host?: SquareHost;
  participant(name?: string): Promise<Participant>;
  join(name?: string, options?: JoinOptions, control?: OperationControl): Promise<JoinResult>;
  history(query?: HistoryQuery, control?: OperationControl): Promise<HistoryResult>;
  status(options?: StatusOptions, control?: OperationControl): Promise<StatusResult>;
  participants(options?: ObservationOptions, control?: OperationControl): Promise<ParticipantsResult>;
  recovery(name?: string, control?: OperationControl): Promise<RecoveryResult>;
  snapshot?(control?: OperationControl): Promise<SquareSnapshot>;
  stream?(options: StreamOptions, control?: OperationControl): AsyncIterable<StreamRecord>;
  close(): Promise<void>;
}
interface SquareCapabilities {
  readonly visibility: 'selective' | 'shared';
  readonly policyEnforcement: 'strict' | 'best-effort';
  readonly automaticAwareness: boolean;
}
interface BackendContext {
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly participant?: string;
  readonly sessions: readonly HarnessSessionIdentity[];
}
interface HarnessSessionIdentity {
  readonly channel: HarnessSessionChannel;
  readonly sessionId: string;
}
interface SquareDriver {
  readonly scheme: string;
  resolve(location: string, context: BackendContext): string | Promise<string>;
  open(location: string, context: BackendContext, control?: OperationControl): Promise<SquareResource>;
  build?(location: string, creation: SquareCreation, context: BackendContext,
    control?: OperationControl): Promise<SquareResource>;
}
interface SquareCreation {
  readonly markdown: string;
  readonly hardCap?: number | null;
  readonly throttlePerMinute?: number;
  readonly template?: string;
  readonly force?: boolean;
}
type CreateSquareDriver = (settings: unknown) => SquareDriver | Promise<SquareDriver>;
```

`Square` is the public resource interface, structurally equivalent to `SquareResource` above; keep the existing `Square.at/build/inMemory` entry points. Settings belong to driver construction, not repeated location arguments. `sessions` is all nonempty harness coordinates from the existing identity table, preserving ambiguity; do not reduce it to the first coordinate. A backend must not infer a different call's identity from its long-lived process. The resolver verifies that resolve returns the selected scheme (or an absolute local path for SQLite), and open/build return that canonical location. This guards routing consistency without interpreting backend grammar.

Use `SquareAtInput.drivers?: readonly SquareDriver[]` for SDK-supplied driver objects, and remove the old `SquareAtInput.backends` command map and its exported `SquareBackends` type. SDK callers needing stdio construct its exported built-in driver factory with settings, or use the shared configuration file. A supplied object may replace the built-in implementation of its scheme for that captured call; duplicate schemes within the supplied list are invalid. Reserve `sqlite` for ordinary filesystem paths and reject `sqlite:` URIs until explicitly supported; all other URI schemes go through a driver. Normalize scheme keys to lowercase, not the remainder of the address. `Square.inMemory` stays an explicitly SQLite convenience. Existing clock, hostLedger, wakeTransport and resources inputs remain SQLite construction dependencies, captured by its built-in driver rather than added to `BackendContext`.

Retain the existing configuration file discovery: `SQUARE_BACKENDS_CONFIG`, otherwise `~/.config/square/backends.json`. Replace its content with this one shape:

```json
{
  "backends": {
    "stdio": {
      "settings": {
        "connections": {
          "local-discussion": { "command": "node", "args": ["/installed/square/dist/stdio-server.js", "--root", "/srv/squares"] }
        }
      }
    },
    "example": {
      "module": "./example-driver.mjs",
      "settings": { "principals": { "faye": "configured-principal-reference" } }
    }
  }
}
```

A module exports `createSquareDriver` of the type above. Relative module paths resolve against the configuration file directory; package specifiers resolve from that directory, absolute paths/file URLs are allowed. Driver-returned scheme must match the configuration key. Built-in `stdio` and `sqlite` entries may omit module; custom schemes require module. The reserved `sqlite` entry selects settings/driver construction for ordinary paths, not a `sqlite:` URI. Reject unknown entry keys and ambiguous duplicate definitions. SDK `drivers` takes precedence over configured entries for matching schemes; there is no second SDK command configuration format. Module imports/factories run only for the selected scheme, once per captured resolver lifetime, with no global mutable registration. A persistent host retains its resolver to reopen notification locations using the same trusted configuration. An individual resource remains call-scoped and must close. CLI/MCP/Pi pass through this same loading path.

## Concrete host capability and awareness flow

Host lifecycle remains one optional object. Its existing concrete result shapes move to public named types, without importing SQLite:

```ts
interface SquareHost {
  recognize(control?: OperationControl): Promise<Participant | null>;
  implicitJoin(name: string, control?: OperationControl): Promise<ImplicitJoinResult>;
  doneOwnedSession(name: string, body: string, expectedEpoch: number,
    control?: OperationControl): Promise<ActivityResult>;
  endOwnedSession(name: string, sessionId: string, expectedEpoch?: number): Promise<ActivityResult | null>;
  retireEndedSessionRoutes(sessionId: string): Promise<void>;
  readonly attention?: SquareAttention;
}
interface ImplicitJoinResult {
  readonly state: 'joined' | 'active' | 'done';
  readonly participant?: Participant;
}
interface AttentionCandidate {
  readonly participant: string;
  readonly activity: ActivityId;
  readonly session: HarnessSessionIdentity;
  readonly generation: string;
}
interface AttentionPreviewData {
  readonly participant: string;
  readonly activity: ActivityId;
  readonly actor: string;
  readonly route: DirectedNotificationRoute;
  readonly body: string;
}
interface SquareAttention {
  watch(control: OperationControl): AsyncIterable<AttentionCandidate>;
  current(candidate: AttentionCandidate, control?: OperationControl): Promise<boolean>;
  preview(candidate: AttentionCandidate, control?: OperationControl): Promise<AttentionPreviewData | null>;
  present(candidate: AttentionCandidate, sink: {
    present(preview: AttentionPreviewData): Promise<void>;
  }, options?: { readonly complete?: boolean }, control?: OperationControl): Promise<boolean>;
}
```

Host methods use the handle's captured sessions; recognition no longer accepts another environment. `endOwnedSession` keeps the explicitly ending session argument and must fence cleanup against current backend ownership. Preserve SQLite epoch behavior behind its adapter; remote implementations may encode their binding version as an opaque generation string for attention. `watch` starts with currently pending candidates for the configured participant/session bindings before waiting for changes, so attaching after a join does not miss prior pending attention. A backend may implement it through polling or native events; abort/close releases the source and no subsequent candidate may be dispatched. No backend-neutral event service or daemon is introduced.

`capabilities.automaticAwareness` is true only when this opened resource has a usable attention capability for the current harness context. Host lifecycle support alone does not imply automatic delivery. No host means automatic recognition/cleanup is unavailable, while named participation continues. Stdio has no host capability in this correction. Local lifecycle callers (`session-lifecycle`, Claude, OpenCode and Pi) check `square.host` and invoke it, never call the removed top-level host methods. Local file discovery remains local; enumerating backend memberships globally is outside this outcome.

The common host observer owns the sequence: open via its captured resolver; acquire `host.attention`; watch with the host run's cancellation signal; select the native delivery boundary from candidate session; immediately before sending, check both run cancellation and `attention.current(candidate)`; obtain backend-owned preview data and render through the existing shared bounded renderer. `current` and `preview` are read-only and must not acknowledge anything. `current` checks standing membership, still-pending activity and exact session/generation ownership. The existing host cancellation/presentation evidence also gates dispatch and is not copied to a second store. A native boundary calls `attention.present` with its actual landing sink; that backend operation fences membership/binding/pending before delivery and receipt commit. The sink resolving means actual native presentation, not queued wake acceptance. `complete:false` prevents receipt consumption for a clipped preview. Sink failure or cancellation must not acknowledge. This preserves the current best-effort delivery boundary, not a claim of a distributed atomic send.

SQLite implements `present` with the existing `presentPending` claim, sink and receipt transaction; its bounded model preview, full Pi human details, clipped handling, omitted-batch suppression, landing acknowledgment and epoch checks remain unchanged. Other backends own any receipt mutation in their implementation of `present`; the generic host never calls `catch` on their behalf or writes artifact receipts. For batched native rendering, preserve the existing render-once sink shared by per-activity presentation calls, and pass completeness for each actually included preview. Omitted entries retain existing local host suppression semantics. Receipt/presentation redesign is outside this architecture correction. The development skill's older awareness-only/catch-only wording conflicts with shipped preview/presentation behavior and current project evidence; update those lines narrowly to describe the preserved boundary.

Adapt the SQLite delivery path through this contract rather than start a second watcher alongside existing dispatch. Existing native transports can retain their request/route structures internally; only the SQLite adapter may derive them from artifact facts. Pass the capability's currentness callback into existing native `beforeSend` gates. All generic revalidation and preview code must avoid opening remote locations as artifacts. The SQLite adapter may continue to use its existing pending sweeps/route evidence; the third driver must reach the same native boundary without importing them. Suppressing a cancelled host run is local evidence, not a backend catch, and a later newly landed activity remains eligible.

The existing host ledger stores local routing/presentation evidence for canonical backend locations too. Add a location-key helper that preserves already-resolved URI strings verbatim and applies the existing filesystem canonicalizer only to paths; use it at generic ledger/evidence and session-projection boundaries. It is not a second URI parser and does not call drivers. Keep `canonicalPath` as a file-only utility. A stored URI is not authorization to load a module: reopening still uses the host's trusted resolver. No storage schema migration or second membership authority is needed.

A long-lived harness attaches attention observers for its configured location at startup and for locations successfully joined/opened through its tools, retaining them until session end or cancellation; it can also recover known local session locations from the existing host presence index. Keep this as in-memory resource lifecycle state, not a new persisted subscription registry. A one-shot CLI has no background observer after exit. Unknown remote memberships are not discovered globally. An explicit catch-only backend never acquires an observer. Reusing the existing Pi host loop requires adapting its source of pending facts and final gate, not running a parallel injection loop.

Shared rendering reads `capabilities` from the opened resource. Add the visibility/policy facts to requested observations where renderer callers only carry results, reusing the existing `automaticDeliveryAvailable` fact for actual current delivery availability. Join/status and applicable guidance disclose shared body visibility and best-effort policy when present; history and awareness must not claim mention privacy. Do not duplicate a static feature table in every activity result or weaken local selective-perception behavior.

### Preserved public facts and adaptation details

- Binding generation and membership epoch are different facts. The existing public participant/ownership API uses numeric membership epochs; backends offering lifecycle support must implement that monotonic per-membership epoch and fence `doneOwnedSession`/`endOwnedSession` against it. `AttentionCandidate.generation` is an opaque version of the session routing binding and is never parsed into a membership epoch. SQLite can encode the relevant current binding facts in that string. A backend unable to offer lifecycle fencing omits `host`; methods on a present host may reject explicitly when unavailable. `retireEndedSessionRoutes` retains its void success and throws a typed unavailable refusal if unsupported.
- Add one exported `harnessSessionIdentities(env)` extractor at the harness identity boundary. Iterate the existing harness environment table and keep each nonempty `{channel,sessionId}` coordinate, deduplicating exact pairs only. Equal session IDs in distinct channels remain distinct. Use it for `BackendContext.sessions`; do not reconstruct channels from the ID-only extractor or reuse first-session selection.
- Shared visibility means perceived activity has `perception:'full'` for all people who can read that shared backend. This is truthful body availability, not a claim that a mention grants privacy. Keep the existing `full | presence` perception type; no new third value is needed.
- Extend the bundled stdio `square/open` response with the opened resource's visibility and policy capabilities; validate them in the client and override automatic awareness to false for this catch-only transport. Update client, bundled server and protocol tests/docs together, without a fallback for the superseded handshake. Do not claim selective visibility for an arbitrary stdio service by hardcoding bundled-server facts.
- Session-scoped attachment is explicitly limited to configured or known locations: startup `SQUARE_LOCATION`, locations successfully used by the host's tools, and existing host presence records. Provide a shared host observer/attachment owner to the persistent harness, pass it into registered tools, attach after successful open/join, and close at session end. Cross-process hooks reopen known locations from URI-safe host presence. A backend with host support must publish its successful local session bindings into that existing host presence index via the host integration, using actual numeric membership epoch and its harness coordinate; the backend remains authoritative and the host validates before dispatch. No remote global membership enumeration is promised. Cold-start cleanup covers known indexed/configured locations only.
- Audit every consumer of host-ledger location fields. `notifications.ts`, `inbox.ts`, `boundary-presentation.ts`, `claude-delivery.ts`, `plugins/opencode/delivery.ts`, `session-lifecycle.ts`, `routes.ts`, `wake-attempts.ts`, `delivery-operations.ts`, `ledger-maintenance.ts` and host projections must either use the captured resolver/capability or explicitly limit the operation to local filesystem locations before artifact/revision access. Generic keys use the URI-preserving location helper. SQLite delivery/sweep internals may stay artifact-shaped behind the adapter; their call sites must never pass a remote location. GC must not prove remote ownership closed by opening a URI as a local artifact; retain evidence unless the backend's authoritative capability proves closure through its supported public facts.

## Delivery and evidence

The architecture correction is one acceptance boundary: a third driver must work without backend-specific caller changes. The contract must include the resolver, resource types, identity and optional host integration, caller adaptation, semantic presentation and documentation needed to demonstrate that outcome. Do not accept a working stdio connection as a substitute for this outcome.

Demonstrate it with a small independently supplied fixture backend whose module does not import SQLite internals:

1. Configure its scheme and use the same location through SDK, CLI, MCP and Pi. Resolve, join, express, history and catch reach the supplied resource with the current participant/session; no local URI-named artifact is opened.
2. Prove two participants can have distinct backend principal bindings at the same location, and two call-local harness sessions do not inherit each other's identity.
3. Exercise its optional attention capability through the common host integration: a hint reaches the current bound session; stale binding/cancelled delivery cannot wake it; hints and preview reads do not consume receipts, while the backend's fenced native presentation preserves its declared receipt semantics.
4. Show the bundled stdio backend still works and reports explicit catch/no automatic delivery accurately. Preserve the existing local SQLite behavior.
5. Verify selective/shared visibility is represented accurately; no test or output treats a mention as privacy on a shared backend.

Use focused behavior tests for these invariants, then the repository's required full suite. No Slack credentials, live messages, App provisioning, release or installation is part of this correction.
