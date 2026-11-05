# Codex delivery

Producers post neutral cards to DeliveryLedger; neither default dispatch nor public `postAndDispatch`
queues Codex input. The receiver owns synchronous presentation and idle queue admission, without
reading Square artifacts or producer content stores.

## Six hooks

The Codex 0.166.0 manifest registers one command for each of six events:

- SessionStart attaches the exact native session and registers its queue address.
- UserPromptSubmit synchronously presents eligible cards as event-correct `additionalContext`.
- PostToolUse synchronously presents eligible cards as event-correct `additionalContext`.
- Stop runs one async `square codex-watch` with a maximum timeout of 86,400 seconds.
- Interrupt cancels the captured attachment's current pending through-sequence batch.
- SessionEnd detaches the captured attachment.

There is no synchronous Stop command or PreToolUse hook. Active delivery occurs when the user
submits a prompt or after a tool finishes; a model-only turn with no tools receives pending cards
after its next Stop through the queue path, or at the next UserPromptSubmit. Host lifecycle never
restores or detaches Square seats. UserPromptSubmit is also the fallback when the hosting
app-server is stdio-only and the idle watcher cannot reach a queue endpoint.

PostToolUse records presentation only after its output sink accepts the response. A later suppression
does not erase that output effect. This is observer-level evidence, not proof of model comprehension.

## One Stop, one wait

Each async Stop captures its payload's native turn ID, ledger attachment generation and queue address.
A private OS-backed lock for that coordinate, generation and turn deduplicates overlapping callbacks.
After winning the lock the watcher records a local Stop epoch (token + turn ID) in the receiver-owned
boundary file; recording before the lock would let a duplicate Stop retire both watchers. A different
Stop or replacement attachment does not wait for the old watcher's lock.

On every reconciliation the watcher re-checks its captured epoch against the local boundary file.
A newer Stop replaces the epoch and retires older watchers; any active native event (SessionStart,
UserPromptSubmit, PostToolUse, Interrupt) clears it and retires the watcher so synchronous hooks own
active-turn presentation; SessionEnd marks the thread ended. No app-server connection, idle proof or
turn-history sampling is involved: the boundary file is the only activity gate.

The watcher subscribes before reading the ledger, uses a one-second bounded rescan, and holds no
card claims while waiting. On an eligible card it claims once and checks ledger currentness,
suppression, cancellation, attachment generation, signal and deadline immediately before queue
invocation. It then ends observation after that handoff attempt, whether accepted, unknown or
definitely unsent. A refusal is not retried in the same wait. Failed/released cards remain available
to UserPromptSubmit/PostToolUse or a future Stop; accepted/unknown custody cannot be replayed.
The original ledger connection is retained only for already-invoked late settlements.

Queue admission writes the shared native queue store (`queue_1.sqlite` under the receiver's
`CODEX_HOME`) through the official `codex queue` CLI. Every Codex app-server hosting a thread polls
that store across processes and starts queued input only when the thread is idle
(`start_turn_if_idle`), so admission never interrupts an active turn and needs no hosting endpoint.

The lock deduplicates overlapping Stop callbacks, not all sequential duplicates forever. Ledger
custody excludes replay of the same card; it is not a persistent one-send-per-turn budget for different
cards. A duplicate callback arriving after the first watcher exits could submit another card before
native history reflects the queued turn.

## Transport and cancellation limits

Queueing uses the official `codex queue` CLI, which discovers the shared app-server daemon and writes
the shared native queue store; `SQUARE_CODEX_ENDPOINT` only selects an explicit remote server.
Because the store is shared per `CODEX_HOME`, a private stdio-only app-server (for example one
launched by another host) still polls and consumes its queued messages. The watcher never starts a
replacement service and never samples native thread state.

Queue admission is custody, not presentation. Accepted/unknown outbox custody has no remaining card
content. Invoked timeout or ambiguous results remain unknown; never automatically replay them.
Already-admitted queue entries cannot be recalled, matching the official CLI.

Interrupt cancellation suppresses the captured attachment's pending batch, not future cards, and the
Interrupt event retires the live watcher through the boundary file. Cards already queued before the
Interrupt stay admitted; future cards wait for UserPromptSubmit/PostToolUse or a later Stop.
Hook payloads do not provide a cross-incarnation event identity: generation capture protects against
replacement after capture, not a callback that was already stale when it began. In particular, a late
Interrupt can still cancel a newer batch in the same attachment. SessionEnd has the same observation-
time capture limitation.

Observation is finite. Before the first Stop, after timeout/crash/missed spawn, or after an unsent
handoff failure, cards wait for UserPromptSubmit/PostToolUse or a subsequent Stop. There is no
detached helper, producer fallback or autonomous crash-idle recovery.

## Native evidence

Reproduce the isolated native smoke after a worktree-local build:

```sh
env -u SQUARE_HOST_LEDGER_ROOT SQUARE_CODEX_NATIVE_SMOKE=1 \
  node --import ./test/sandbox-env.js test/codex-watch-native.mjs
```

The probe uses a temporary HOME/CODEX_HOME, actual shipped hooks/CLI, an isolated native app-server
with an explicit Unix endpoint, and a loopback fixture provider. Its JSON evidence names the temporary
directory. It verifies Stop startup, one-shot idle wake and exit, fresh watchers for new Stops, busy
fencing with no pending cards, Interrupt RPC cancellation, future delivery through UserPromptSubmit,
real PostToolUse context and receipts, and termination of a still-waiting watcher at host shutdown.
It does not certify physical TUI Escape, 24-hour lifetime or every resume path.

The shared package's separate public boundary/transport helpers remain documented in
[its README](../packages/agent-delivery/README.md). See [participant ownership](participant-ownership.md)
for host attachment and Square membership.
