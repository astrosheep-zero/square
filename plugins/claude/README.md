# Square for Claude Code

This plugin adds Square's MCP tools, participation skill and native JavaScript mod. Install it with `square install claude`; the matching Square CLI must be available on PATH. macOS Claude Code 2.1.319 is tested.

During a running turn, the mod appends notification context and emits a native UI log. An idle main session receives only a plugin-attributed, body-free wake; the same mod's `classic.UserPromptSubmit` boundary fetches current context before the model snapshot. Wake admission neither consumes cards nor records receipts. An obsolete wake may be empty but cannot replay an old body. Stop suppresses the current delivery batch; uncertain appends are held without automatic replay. Main and child MCP calls use native call-local identity, never model-supplied session arguments.

One private helper per mod session owns the delivery ledger connection. No producer callback service is needed. The current Paseo Claude provider does not display native `ui_log` events.

See [Claude delivery](../../guides/claude-native.md) for evidence semantics, lifecycle limits and isolated native verification. License: MIT.
