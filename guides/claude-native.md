# Claude mod delivery

Square's Claude plugin uses a native JavaScript mod, not command hooks or an async Stop observer. The mod owns native lifecycle and effects. One `square claude-mod` helper per loaded session owns Node/SQLite access and the receiver-owned `claude-mod` ledger route. Producers only post neutral ledger cards; they never contact the helper directly.

## Busy context and idle wake

During a running turn, the mod calls `$.session.append` with the complete delivery frame, then `$.ui.log` with the readable card. Append adds model context without interrupting the running turn; the separate log makes the notification visible in Claude's native UI. Neither replaces a tool result. A busy notification is never also submitted as a new prompt.

When the main session is idle, the mod instead calls `$.prompt.submit({ text })`. It keeps native plugin attribution: it does not set `asUser`, impersonate human input, or emit a duplicate UI log. Normal completion returns the receiver to idle so later cards can wake it again. A child receives append only while running, addressed by its native `agentId`; Square never wakes the main session on behalf of an idle child. Child completion detaches its receiver.

The current Paseo Claude provider does not expose native `ui_log` events in its conversation UI. Emitting a log is not evidence that Paseo displayed it, and the optional Square Paseo renderer does not fix that provider boundary. This change does not modify Paseo.

## Evidence, cancellation and lifetime

Each handoff prepares a unique token and SHA-256 hash of the exact frame. A private loopback RPC rechecks generation and custody immediately before the native effect. An append receipt requires the native returned message to contain exactly that text and a native message UUID. A submit receipt requires the returned submitted text to match exactly; rewritten text records acceptance only. These are native acceptance/presentation facts, not proof of a later provider request, model comprehension or human acknowledgement. UI logs alone never settle a delivery.

There is no atomic transaction spanning the ledger and Claude. Once an effect may have happened, a lost or changed result is uncertain and held: no automatic replay, append-to-submit retry, or fallback wake through another host. Definitive refusal creates no presentation receipt. Diagnostics and `square harness doctor delivery` distinguish pending, held and presented evidence.

Stop cancels the current pending batch and fences queued native effects. A stopped receiver does not wake again until new native input starts a turn; later input does not replay the cancelled batch. Already appended or admitted native input cannot be recalled. Cancellation is local host suppression, not consumption of Square history.

`session.end` retires the captured helper and generation-fenced attachment. `/clear` and `/resume` can end the old session without another `session.start`; the next native prompt lazily starts the helper for the current session ID. Reloading the mod starts a fresh helper generation, which fences older receivers. A hard process kill can prevent graceful detach; a subsequent attachment fences the old generation, but installation alone does not prove that any running host loaded the mod.

The helper emits its randomly authenticated loopback address only to the owning mod over its private process stream. That address is not a producer endpoint, shared inbox, or public configuration. No external callback service is required.

## MCP call identity

The bundled MCP server gets session, cwd and subagent attribution from the mod's native `tool.call` wrapper, matched only to Square MCP tools. Before calling the real tool, it captures the native `tool_use_id`, session and `agentId` in the call-local association keyed by Claude's `claudecode/toolUseId` metadata. A `finally` block removes only that exact association after the tool finishes, including failure. Calls interrupted before cleanup expire after ten minutes.

Missing, duplicate, expired or mismatched identity fails closed before the MCP server runs. Models cannot supply identity as tool arguments. Main and child identities stay separate even when their calls overlap; no ordinary non-Square tool launches an identity command.

## Tested runtime and verification

macOS Claude Code **2.1.319** was tested with the shipped plugin, candidate CLI, isolated HOME/configuration/ledger, and a dummy-key loopback model provider. The real headless runtime proves repeated idle wake, duplicate suppression, busy append reaching the next model request, native UI-log emission, Stop suppression, exact receipts and detach. A real interactive TUI fixture proves main/child MCP attribution, collision denial, tool-context delivery and exact call cleanup. This does not certify older Claude releases, other platforms, or Paseo display.

After `npm run build`, run both native fixtures with:

```bash
SQUARE_CLAUDE_MOD_NATIVE_SMOKE=1 \
SQUARE_CLAUDE_BIN=/path/to/claude \
node --import ./test/sandbox-env.js test/claude-mod-native.mjs
```

Evidence stays in the printed `/tmp/square-claude-…` directories. The headless fixture deliberately interrupts a running tool; Claude may finish with exit 1 and `aborted_tools`, which is checked as the expected interruption rather than treated as an ordinary successful generation. Neither fixture uses external model credentials or changes an installed plugin or running host.
