# Codex delivery

Square uses the Codex leaves in `packages/agent-delivery/src`. The hook path receives ledger cards
at `PostToolUse` as bounded `additionalContext`; the queue path sends from the ledger at an eligible
Stop boundary. The ledger's handoff and presentation attempt state prevents competing tracks from
double-presenting the same card. Queue admission is custody, not proof of presentation or model
comprehension; an uncertain send must not be blindly retried.

`SessionStart` and `SessionResume` attach the exact host session in the ledger, while `SessionEnd`
detaches it. Membership, listens and read horizon remain Square-owned; there are no seat lifecycle
restore or detach hooks. Detached participants stay away with their unread audience intact. A missed
host lifecycle event cannot be inferred from a queue result. `SessionEnd` supplies a session ID but
no event instance or generation: the hook can fence only the attachment observed when it runs. It
cannot identify an already-delayed end event from an older incarnation of that same session.

The shared package documents the Codex CLI and app-server transports, endpoint configuration and
native limitations in [its README](../packages/agent-delivery/README.md). No automatic fallback
bypasses native policy. See [participant-ownership.md](participant-ownership.md).
