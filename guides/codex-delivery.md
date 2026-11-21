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
The overlap fence uses the shared agent-delivery file lock, separate from ledger/queue evidence.
After winning the lock the watcher records a local Stop epoch (token + turn ID) in the receiver-owned
boundary file; recording before the lock would let a duplicate Stop retire both watchers. The store
returns the exact epoch it committed from that locked write, so the watcher never re-reads shared
state for its authority: a later Stop owns a different epoch. A different Stop or replacement
attachment does not wait for the old watcher's lock.

On every reconciliation the watcher re-checks its captured epoch against the local boundary file.
A newer Stop replaces the epoch and retires older watchers; any active native event (SessionStart,
UserPromptSubmit, PostToolUse, Interrupt) clears it and retires the watcher so synchronous hooks own
active-turn presentation; SessionEnd marks the thread ended. No app-server connection, idle proof or
turn-history sampling is involved: the boundary file is the only activity gate.

The watcher subscribes before reading the ledger, uses a one-second bounded rescan, and never
claims cards. When an eligible card exists, it queues only a fixed, body-free wake. It rechecks the
captured boundary epoch, route, attachment generation, pending eligibility, signal and deadline
immediately before launch. One attempt ends the wait, whether accepted, unknown or definitely
unsent; there is no same-wait retry. Wake admission neither takes card custody nor records a
presentation receipt. Cards remain in the ledger for UserPromptSubmit/PostToolUse.

Queue admission writes the shared native queue store (`queue_1.sqlite` under the receiver's
`CODEX_HOME`) through the official `codex queue` CLI. Every Codex app-server hosting a thread polls
that store across processes and starts queued input only when the thread is idle
(`start_turn_if_idle`), so admission never interrupts an active turn and needs no hosting endpoint.

The lock deduplicates overlapping Stop callbacks, not all sequential duplicates forever. A duplicate
callback arriving after the first watcher exits can enqueue another body-free wake. At execution,
UserPromptSubmit presents only currently eligible cards. A wake whose cards were already perceived,
suppressed or presented may produce an empty model turn; it never carries the old body.

## Transport and cancellation limits

Queueing uses the official `codex queue` CLI, which discovers the shared app-server daemon and writes
the shared native queue store; `SQUARE_CODEX_ENDPOINT` only selects an explicit remote server.
Because the store is shared per `CODEX_HOME`, a private stdio-only app-server (for example one
launched by another host) still polls and consumes its queued messages. The watcher never starts a
replacement service and never samples native thread state.

Queue admission is only a wake, not card custody or presentation. An ambiguous wake is not retried
in the same wait and does not mark any card unknown. The original body remains available to the
synchronous receiver. Already-admitted wake entries cannot be recalled, matching the official CLI;
they contain no activity body to replay.

Interrupt cancellation suppresses the captured attachment's pending batch, not future cards, and the
Interrupt event retires the live watcher through the boundary file. Wakes already queued before the
Interrupt stay admitted, but cancelled bodies cannot revive through them; future cards wait for
UserPromptSubmit/PostToolUse or a later Stop.
Hook payloads do not provide a cross-incarnation event identity: generation capture protects against
replacement after capture, not a callback that was already stale when it began. In particular, a late
Interrupt can still cancel a newer batch in the same attachment. SessionEnd has the same observation-
time capture limitation.

Observation is finite. Before the first Stop, after timeout/crash/missed spawn, or after an unsent
wake failure, cards wait for UserPromptSubmit/PostToolUse or a subsequent Stop. There is no
detached helper, producer fallback or autonomous crash-idle recovery.

## Native evidence

Reproduce the isolated native smoke after a worktree-local build:

```sh
env -u SQUARE_HOST_LEDGER_ROOT SQUARE_CODEX_NATIVE_SMOKE=1 \
  node --import ./test/sandbox-env.js test/codex-watch-native.mjs
```

The probe uses a temporary HOME/CODEX_HOME, actual shipped hooks/CLI, an isolated native app-server
with an explicit Unix endpoint, and a loopback fixture provider. Its JSON evidence names the temporary
directory. It verifies Stop startup, body-free idle wake and exit, current card presentation and
receipts at the queued turn's native UserPromptSubmit, fresh watchers for new Stops, busy
fencing with no pending cards, Interrupt RPC cancellation, future delivery through UserPromptSubmit,
real PostToolUse context and receipts, and termination of a still-waiting watcher at host shutdown.
It does not certify physical TUI Escape, 24-hour lifetime or every resume path.

The shared package's separate public boundary/transport helpers remain documented in
[its README](../packages/agent-delivery/README.md). See [participant ownership](participant-ownership.md)
for host attachment and Square membership.
