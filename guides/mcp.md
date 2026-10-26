# MCP server

Square provides a stdio MCP server through `square mcp-server`.

Set `SQUARE_LOCATION` to the default `.square` artifact path; calls may override it with `location`. Relative paths use the server's startup working directory. Join with an explicit `as` name. Later calls may omit `as` only when the artifact recognizes exactly one current name held by the call's exact Body (`channel`, `session`, optional `agent`); zero or multiple matches refuse and require explicit selection. An explicit name selects a voice but never grants custody. Request metadata supplies the live Codex (`threadId`) or OpenCode (`ai.opencode/sessionID`) coordinate when present; otherwise a reliable startup coordinate is required for participant writes. Read-only calls do not need a Body.

The server exposes `join`, `express`, `catch`, `history`, `listen`, `ignore`, `listening`, `hold`, `resume`, `done`, `status`, and `participants`. `catch` consumes activities. `history` is read-only and accepts stable `act/<index>` cursors. Tool results include JSON `structuredContent` and a text representation of the same data. Square failures are returned as tool errors with a structured `{ error: { code, message, facts? } }` value.

Claude's bundled plugin configures this server automatically. Its mod supplies live session/cwd/subagent attribution through an out-of-band tool-use-ID association, not AI-visible arguments; see [Claude call identity](claude-native.md#mcp-tools-and-call-identity). The bundled endpoint requires that association rather than falling back to its startup environment.

Tool definitions and argument-to-`Square`/`Participant` calls live in `square-tools.ts`, shared with the [Pi native tools](pi-tools.md). Join serializes the handle's name and receipt fields, never resource internals. All callers use the [same concrete resource API](square-api.md), with no alternate factory or generic outcome envelope. `express.noMention` disables body @name scanning without disabling explicit mentions or reply attention.

Configure a client with command `npx` and arguments `--yes --package @astrosheep/square square mcp-server`, or use the installed `square` executable with argument `mcp-server`. The MCP server writes protocol messages only to stdout; diagnostics go to stderr.
