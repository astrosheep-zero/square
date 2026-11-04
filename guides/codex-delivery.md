# Codex delivery

Producers post neutral cards to DeliveryLedger; neither default dispatch nor public `postAndDispatch`
queues Codex input. The receiver owns synchronous presentation and idle queue admission, without
reading Square artifacts or producer content stores.

## Five hooks

The Codex 0.166.0 manifest registers one command for each of five events:

- SessionStart attaches the exact native session and registers its queue address.
- PostToolUse synchronously presents eligible cards as event-correct `additionalContext`.
- Stop runs one async `square codex-watch` with a maximum timeout of 86,400 seconds.
- Interrupt cancels the captured attachment's current pending through-sequence batch.
- SessionEnd detaches the captured attachment.

There is no synchronous Stop command, UserPromptSubmit hook, or PreToolUse hook. Active delivery
occurs after a tool finishes; a model-only turn with no tools receives pending cards after its next
Stop through the queue path. Host lifecycle never restores or detaches Square seats.

PostToolUse records presentation only after its output sink accepts the response. A later suppression
does not erase that output effect. This is observer-level evidence, not proof of model comprehension.

## One Stop, one wait

Each async Stop captures its payload's native turn ID, ledger attachment generation and queue address.
A private OS-backed lock for that coordinate, generation and turn deduplicates overlapping callbacks.
A different Stop or replacement attachment does not wait for the old watcher's lock. The watcher
never adopts a newer Stop and never starts its own successor; Codex starts the next watcher when the
next turn stops.

On every reconciliation, even with no pending cards, the watcher reads the hosting endpoint's
`thread/read(includeTurns:true)`. Only a loaded idle thread whose newest completed turn exactly
matches the captured ID may authorize queueing. The same turn still settling may wait; a newer,
interrupted or failed turn retires the watcher. Unreadable, malformed, notLoaded or unsupported history
ends idle observation with a bounded diagnostic. Newest-last history is verified for 0.166.0 only.
There is no second persisted root Stop-authority store for delayed callbacks to overwrite.

The watcher subscribes before reading the ledger, uses a one-second bounded rescan, and holds no
card claims while waiting. On an eligible card it claims once, repeats the native idle check, and
checks ledger currentness, suppression, cancellation, attachment generation, signal and deadline
immediately before queue invocation. It then ends observation after that handoff attempt, whether
accepted, unknown or definitely unsent. A refusal is not retried in the same wait. Failed/released
cards remain available to PostToolUse or a future Stop; accepted/unknown custody cannot be replayed.
The original ledger connection is retained only for already-invoked late settlements.

The lock deduplicates overlapping Stop callbacks, not all sequential duplicates forever. Ledger
custody excludes replay of the same card; it is not a persistent one-send-per-turn budget for different
cards. A duplicate callback arriving after the first watcher exits could submit another card before
native history reflects the queued turn.

## Transport and cancellation limits

Idle queueing requires an externally reachable endpoint for the app-server already hosting the
thread: `SQUARE_CODEX_ENDPOINT`, or the control socket under that receiver's `CODEX_HOME`. Queue uses
that endpoint explicitly and never starts a replacement service. A private stdio-only app-server
without a control endpoint cannot be reached by a new process. In that case the async watcher exits;
PostToolUse still presents cards through the native hook without any app-server connection.
A completed async hook's own output does not wake an idle Codex turn.

Queue admission is custody, not presentation. Accepted/unknown outbox custody has no remaining card
content. Invoked timeout or ambiguous results remain unknown; never automatically replay them.
Native reads and external queue are not atomic: a user turn or interruption can race after the final
check, and admitted input cannot be recalled.

Interrupt cancellation suppresses the captured attachment's pending batch, not future cards. A native
interrupted turn retires its watcher; future cards can be received at PostToolUse or a later Stop.
The native smoke exercises active `turn/interrupt`, not physical TUI Escape or idle cancellation paths.
Hook payloads do not provide a cross-incarnation event identity: generation capture protects against
replacement after capture, not a callback that was already stale when it began. In particular, a late
Interrupt can still cancel a newer batch in the same attachment. SessionEnd has the same observation-
time capture limitation.

Observation is finite. Before the first Stop, after timeout/crash/missed spawn, or after an unsent
handoff failure, cards wait for PostToolUse or a subsequent Stop. There is no detached helper,
producer fallback or autonomous crash-idle recovery.

## Native evidence

Reproduce the isolated native smoke after a worktree-local build:

```sh
env -u SQUARE_HOST_LEDGER_ROOT SQUARE_CODEX_NATIVE_SMOKE=1 \
  node --import ./test/sandbox-env.js test/codex-watch-native.mjs
```

The probe uses a temporary HOME/CODEX_HOME, actual shipped hooks/CLI, an isolated native app-server
with an explicit Unix endpoint, and a loopback fixture provider. Its JSON evidence names the temporary
directory. It verifies Stop startup, one-shot idle wake and exit, fresh watchers for new Stops, busy
fencing with no pending cards, Interrupt RPC cancellation, future delivery, real PostToolUse context
and receipts, and termination of a still-waiting watcher at host shutdown.
It does not certify stdio-only idle wake, physical TUI Escape, 24-hour lifetime or every resume path.

The shared package's separate public boundary/transport helpers remain documented in
[its README](../packages/agent-delivery/README.md). See [participant ownership](participant-ownership.md)
for host attachment and Square membership.
