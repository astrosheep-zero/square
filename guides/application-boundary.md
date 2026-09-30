# Application boundary

Square has three layers around an activity operation:

- **Domain** (`decisions.ts`, `catch-decisions.ts`, and projections) applies
  SquareState rules and perception without transport or CLI concerns.
- **Application** (`square-application.ts`) receives an explicit caller
  snapshot, resolves defaults and ambiguity, coordinates facade operations,
  owns resources, applies express wait/no-wait policy, and returns structured
  data. It never reads ambient process state from inside an application call.
- **Transport and presentation** (the CLI today, Pi and MCP later) parse input,
  read stdin, render sensory output, build recovery commands, and choose process
  exit behavior.

The application boundary exposes only neutral `HostLedgerPort` behavior. Ledger
layout, storage scopes, and hook reconciliation remain adapter concerns and are
intentionally absent. Exact lifecycle cleanup remains owned by the ledger/registry
adapter used by the facade.

The CLI now delegates join/reconnect/takeover gates and cleanup, express admission
and retry/no-wait behavior, catch/history, listener operations, lifecycle actions,
and status/participant projections to the application layer. It retains only
transport-specific details: argv validation, stdin body resolution, ANSI and
sensory rendering, continuation/recovery commands, watch leases and signals,
and process exit codes. Advanced history display context (`--at`, `-A`, `-B`,
`-C`) remains a presentation concern while the ordinary archive/filter/cursor
path uses the application history operation.

Application operations accept the final `OperationControl` coordinate as their
last control argument and forward it to facade operations. This is deliberately
separate from the transport's rendering and does not create a second cancellation
model.
