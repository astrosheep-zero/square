# Claude native inbox

Square's Claude plugin is a mod, not a shell-hook injector. Its `hooks/hooks.json`
contains only `{"modules":["./register.js"]}`. Install with `square install claude`
and load/approve it in a trusted interactive Claude terminal. Installation is
not evidence of a live receiver.

## Validated capability

The supported baseline is **macOS Claude Code 2.1.295 with the mod actually
loaded**. The receiver reads its real session ID, cwd, version, and
`CLAUDE_CODE_MESSAGING_SOCKET`. A session ID or socket alone is not capability.
Missing/disabled/unapproved mods, the normal unapproved headless `-p` path,
other builds, and other platforms are unavailable. No legacy fallback exists.
Square never changes inbound policy, forwards a child token, or impersonates a
peer/plugin authority. Native OS-user socket permissions and Claude policy apply.

`square harness doctor claude` explains installation and these limits.
`square harness doctor delivery` derives current routes/evidence without sending.
An absent/broken endpoint is unavailable; it does not consume Square activity.

## Membership and lifecycle

If `.square/PUBLIC.square` already exists, the mod joins the automatic participant.
It never creates PUBLIC. Existing manual memberships also reconcile independently
of PUBLIC. Main-conversation tool completion (including failed/aborted tools) and
conversation start reconcile late memberships: the receiver itself publishes
routes; the CLI cannot infer mod capability from a socket or session environment.
This reconciliation injects no activity and does not poll. Its recovery sweep
only sends previously unsent eligible attention, never unknown/admitted attempts.

Initial activation and hot reload use `session.start`. New conversations use
`classic.SessionStart`: clear reads the new API coordinate; **resume's event
`session_id` is already the resumed coordinate while `$.session.id()` still reads
the ending one in 2.1.295**. The event coordinate is used at that boundary, with
API cwd/version/socket. Modern `session.end` retires only its pinned `e.sessionId`
and captured ownership epochs, within the event budget. Late committed joins
are discovered at the pinned end timestamp. A process crash can omit end.

A resumed conversation restores only memberships whose last lifecycle activity
is exactly the `done` recorded by its previous confirmed end in the existing
host ledger. It never takes another owner's participant or re-enters a later
explicit user `done`. Restoration advances the binding epoch, so callbacks and
old ends cannot retire that replacement. Unchanged reload preserves epochs.

## Body, admission, and presentation

The coordinator uses Square's canonical audience projection and bounded body
preview. A clipped preview ends with the full `catch --id act/<index>` command.
Opaque text correlation resolves through bound memberships and the existing
attempt ledger, never a path or asserted source from incoming text.

The reusable transport is the same Node-only leaf published as
`@astrosheep/agent-delivery/claude-native`, sourced from
`packages/agent-delivery/src/claude-native.ts`. Square imports that source directly;
its root package ships the compiled leaf without loading the OpenCode SDK or
requiring a separate agent-delivery installation. There is no second socket sender.

The leaf accepts only target/session endpoint, text, and bounded
deadline/cancellation control. It writes tokenless `msgV:1`, session-targeted
UTF-8 NDJSON with `priority:'next'`. **Socket write is not admission or seen.**
External consumers may use the standalone package's `connectExisting`/`sendText`
with `{harness:'claude', sessionId, endpoint}`. The endpoint must be an explicit
absolute native socket path from the receiver; the package does not discover it
from an arbitrary session ID. Its `steer` means the next native boundary, not
interruption; `queue` and caller input IDs are unsupported. A plain native peer
does not require Square's mod, which adds Square-specific lifecycle/evidence only.
The generic package reports `written`/`unknown`/`unavailable`, never native
admission. Native permissions and inbound policy remain authoritative.

`session.receive` runs before native policy. `await next(e)` confirms queue
admission only when the returned text is unchanged. Hold/refuse reject that gate;
consumed/rewritten results cannot confirm the original. Unknown peer messages
pass through. Recognized stale/cancelled deliveries can be consumed before queueing.
No ambiguous send is blindly retried.

The sole presentation writer observes **returned stored main user-role text**
after `session.append.next`. It matches the entire expected payload within
Claude's idle/busy peer framing. A complete preview records seen + presented;
a clipped one records clipped only. This means stored in model context, not
processed or understood. Native hold release does not replay receive; append
still confirms it. Catch/presentation races are idempotent and revalidated
immediately before send and inside the observation transaction.

## Cancellation and custody

Explicit plugin `turn.abort` and terminal `turn.complete(reason:'aborted')`
suppress the outstanding local batch without recording seen. Ordinary answer,
refusal, and error completion are not user cancellation. Separate engine-owned
family state survives hot reload, containing the abort timestamp and frozen
membership epochs. Same-epoch host-ledger presence stores a monotonic activity
cutoff; replacement generations cannot inherit the old abort.

Engine state reads are snapshots of one dispatch. Confirmation therefore uses
one immediate fresh `clock.after` dispatch to read cancellation, not a repeated
read in the old dispatch. It is not polling. If reload cancels a pending callback,
its evidence stays unknown: reload does not replay it. A failed cancel bridge
can be repaired by the fresh confirmation/reconciliation dispatch from retained
engine state. If all bridge/state operations are unavailable, Square cannot
promise a receipt or suppression; it fails boundedly and preserves unrelated
Claude behavior.

**Already queued OR natively held messages cannot be retracted.** Approval may
release a held message without another receive guard. Append is observational,
not a veto. Square suppresses local retries and stale evidence but cannot erase
native custody or promise that remote work will not run. New activity after the
abort remains eligible. The protocol and runtime evidence used for this migration is retained in the
commission artifacts `/tmp/claude-inbox-design-validation.md` and
`/tmp/square-claude-final-runtime.log`; the latter records the shipped plugin's
isolated idle, busy, hold, lifecycle, fork, and cancellation runs. The repository
fixtures cover the same coordinator and packaging boundaries without requiring a
Claude installation.
