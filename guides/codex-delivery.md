# Codex delivery

Producers post neutral cards to DeliveryLedger; neither default dispatch nor public `postAndDispatch`
queues Codex input. A native receiver owns both synchronous presentation and idle queue admission.
It never reads Square artifacts or producer content stores.

The shipped hooks for Codex 0.166.0 are synchronous SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, Stop, Interrupt and SessionEnd, plus an async Stop command with `timeout: 86400` seconds.
SessionStart disarms and attaches the exact native session. Active prompt/tool boundaries disarm and
present eligible cards as event-correct `additionalContext`, using neutral reminder framing and the
original card text. The output sink must accept the response before presentation evidence is recorded;
a later suppression does not erase a real output effect. SessionEnd disarms and detaches. None of these
host lifecycle events restores or detaches Square seats. SessionResume is not a verified native event
and is not registered. A resume path without a real SessionStart/Stop has no inferred idle authority.

Each synchronous Stop stores a unique token and native turn ID in the existing boundary store. One
receiver-owned `square codex-watch` command holds a separate private OS-backed lock for its native
session coordinate and observes the ledger, with a one-second bounded rescan for boundary changes or
missed notifications. Duplicate async Stop processes exit; the existing watcher follows newer Stop
tokens. The lock does not prove idle state. Observation never reserves cards while waiting.

Before claiming each card, the watcher reads the hosting endpoint's `thread/read(includeTurns:true)`.
It requires loaded idle state and the newest live turn to be completed with exactly the captured Stop
turn ID. Newest-last history ordering is verified for 0.166.0; other versions fail closed until verified.
After claiming, the receiver repeats that native read, checks the exact epoch again, then checks ledger
currentness, suppression, cancellation, attachment generation, signal and deadline immediately before
CLI invocation. Queue always uses the existing hosting endpoint explicitly, without starting a service.
Missing, malformed, ephemeral, notLoaded, active, interrupted or unreadable history cannot authorize a
queue. A delayed stale Stop cannot authorize sending merely by arriving after an active callback.

`square codex-interrupt` handles only a native Interrupt payload and cancels the captured attachment's
pending through-sequence batch, then future cards remain available after a later verified Stop or active
boundary. Replacement attachments are fenced by generation. Before-effect epoch/suppression/cancel
failures release their claims where the ledger permits. Attachment rotation already normalizes an
in-flight ledger attempt to unknown: that custody remains unknown even if the final receiver check
then proves no queue was launched. The watcher exits on detach, deletion or generation change and
retains its ledger connection only for already-captured late settlements.

Queue admission is custody, not presentation or model comprehension. Accepted/unknown outbox custody
has no remaining card content and cannot be automatically replayed. Invoked timeout or ambiguous
results remain unknown. Native idle reads and external queue are not atomic: a new turn can start after
the final check and a raced queue may arrive later. Interrupt cannot recall input already admitted by
Codex, and hook failure/timeout cannot prove that cancellation happened. Native callbacks have no
cross-incarnation event identity; SessionEnd can fence only the attachment observed when it runs.

There is no watcher before the first Stop. Synchronous boundaries can present; otherwise cards wait.
The async budget is finite 24 hours, not a promise of 24-hour observation. After timeout, crash, host
termination or missed spawn while idle, cards wait for the next Stop/user/native boundary. There is no
producer fallback or autonomous crash-idle recovery. During attachment replacement an old watcher
may briefly retain the coordinate lock while the new Stop's duplicate exits; the next Stop restores
observation after the old process releases it.

Reproduce the isolated native smoke from this checkout after a worktree-local build:

```sh
env -u SQUARE_HOST_LEDGER_ROOT SQUARE_CODEX_NATIVE_SMOKE=1 \
  node --import ./test/sandbox-env.js test/codex-watch-native.mjs
```

The probe creates a temporary HOME/CODEX_HOME, installs no plugin, and uses the actual shipped hook
manifest/CLI with an isolated native app-server and loopback fixture provider. Its JSON evidence names
the temporary directory. It verifies native Stop startup, idle wake, busy fencing, singleton reuse,
Interrupt RPC cancellation, real UserPromptSubmit presentation and process-group shutdown. Physical
TUI Escape-to-Interrupt is not verified; neither are 24-hour operation or every resume path.

The shared package documents its transport leaves in [its README](../packages/agent-delivery/README.md).
See [participant ownership](participant-ownership.md) for host attachment and Square membership.
