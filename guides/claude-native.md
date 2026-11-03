# Claude native inbox

Square's Claude plugin is a mod, not a shell-hook injector. Its MCP server uses the mod's call-local
session association; a missing or expired association fails closed. A session ID or socket alone does
not establish that the mod is loaded. The supported native path requires macOS Claude Code with the
mod loaded and approved. Square does not alter inbound policy or bypass a held peer message.

The mod attaches and detaches the exact host session in the delivery ledger. Membership remains in
Square; host end does not land `done`, and start/resume does not restore seats. See
[participant-ownership.md](participant-ownership.md).

The sender dispatches finished ledger cards through the native socket. Native admission settles a
handoff as accepted, not presented; the stored main user-role text observation settles presentation
through its handoff reference. This establishes observation at that boundary, not comprehension, and
cannot promise that a later plugin leaves the card intact. Unknown native custody is not a safe reason
to replay through another route. A shortened activity card points to catch; Square only folds a receipt
for a full card into its read state. Direct producer notices retain their full body.

`turn.abort` cancels the outstanding ledger batch without asserting it was read. Already queued or
natively held messages cannot be recalled. The shared transport and its validated limits are documented
in [agent-delivery's README](../packages/agent-delivery/README.md) and `VALIDATION.md`.
