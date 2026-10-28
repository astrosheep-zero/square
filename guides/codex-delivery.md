# Codex delivery

Square uses the shared Codex leaves in `packages/agent-delivery/src`, rather than
maintaining a second hook protocol, boundary store or CLI sender. The standalone
package's [README](../packages/agent-delivery/README.md) describes both its native
app-server capability and its host-owned hook integration.

## Square's hook path

`plugins/codex/hooks/hooks.json` invokes `square codex-hook`:

- `SessionStart`, `SessionResume` and `UserPromptSubmit` invalidate the previous
  Stop observation. `SessionEnd` marks the session ended and ends Square's owned
  memberships. Later Stop/tool callbacks cannot re-enable queue until a new
  `SessionStart` or `SessionResume`.
- `PostToolUse` asks Square for current pending activity and returns the existing
  bounded `additionalContext` presentation.
- `Stop` records queue eligibility and sweeps pending work, but does not itself
  claim that a preview was presented.

The shared handler owns hook framing, lifecycle sequencing, its cancellation
budget and bounded sweeps. Square supplies activity selection, formatting,
artifact-owned presentation claims, cancellation, membership cleanup and
pending-work sweeps. The handler cooperatively awaits Square's pull: the signal
cancels work before presentation, but a successful presentation's `settleAs`
finishes independently of request cancellation. Even when that settlement crosses
the internal budget, the hook waits for it and returns the associated context;
it never abandons settlement that can mark activity seen without returning text.
After expiry, no sweep starts, and a sweep timeout cannot erase successful pull
output. Settlement must still finish within Codex's external hook timeout. Hook inbox lookup uses
an exact Body (`{ channel: 'codex', session }`), not a bare session id. The shared
boundary store uses Square's caller-selected `SQUARE_CODEX_BOUNDARIES` file,
defaulting to `~/.square/codex-boundaries.json`; its JSON observations are not
conversation storage and are not proof of current native execution or consumption.
Square's format5 artifact remains authoritative for seats and delivery evidence.

`CodexQueueTransport` implements the existing `WakeTransportPort` and uses the public
`connect({ harness: 'codex', transport: 'cli', sessionId, boundaries, ... })`
and `agent.queue(text)` interface, just like independent hosts. Square reads its
stored pending preview and finishes its currentness gate first; the bound client
checks boundary eligibility once inside `queue()`, then launches the CLI. No
caller-side lifecycle check is duplicated. Outcomes continue through the existing
artifact-owned delivery path; no host ledger or new route kind is introduced.

Both CLI coordinate creation and MCP call-local Codex coordinates capture the
recipient's `CODEX_HOME` (or home default), so later senders use the recipient's
CLI configuration rather than their own. Only an explicitly configured
`SQUARE_CODEX_ENDPOINT` adds a remote endpoint. `SQUARE_CODEX_BIN` remains
Square's executable selection; it is not an environment convention of the
independent package.

By default the sender runs `codex queue --thread ... --message ...`, allowing the
CLI's normal connection/startup behavior. Only an explicit endpoint adds
`--remote`. This does not make another host's private stdio pipe attachable.
After an observed `SessionEnd`, Square does not dispatch queue; the bound lifecycle
check also catches an end observed while the currentness gate was running.
It cannot retract a submission already launched or infer a missed end hook.
Queue success means native admission only; its receipt id is a local attempt
UUID, not a server message id. The child runs asynchronously and respects the
send's abort signal/deadline. Timeout, killed child and unexplained post-launch
failures remain unknown, not a safe reason to resend. A receiver with no tool
calls waits for Stop; this path is not instantaneous native steer.

## Optional native app-server capability

Independent consumers can use `connect({ harness: 'codex', sessionId, endpoint })`
from `@astrosheep/agent-delivery` for fenced busy steer and native queue.
`transport: 'app-server'` is the explicit spelling and the default when omitted;
it exposes both methods. `transport: 'cli'` exposes queue only and requires the
host's hook lifecycle source at connection time. There is no automatic fallback
between transports. The app-server transport never starts a service or calls
`thread/resume`. This does not replace Square's hook policy or add a new persisted
Square route kind. A loaded thread's owner remains its existing host, not the
external sender.

Neither path implements a read-receipt roundtrip. Admission and runtime
observations must not be presented as model comprehension or completion. An
unknown outcome stays unknown. Installing, restarting or changing a real Codex
server is outside this integration.
