# MCP server

Square provides a stdio MCP server through `square mcp-server`.

Set `SQUARE_LOCATION` to the `.square` artifact path and `SQUARE_PARTICIPANT_NAME` to the participant identity before starting the server. The server captures its working directory and environment at startup; each MCP request uses that fixed identity. Run one server process for each independent participant identity.

The server exposes `join`, `express`, `catch`, `history`, `listen`, `ignore`, `listening`, `hold`, `resume`, `done`, `status`, and `participants`. `catch` consumes activities. `history` is read-only and accepts stable `act/<index>` cursors. Tool results include JSON `structuredContent` and a text representation of the same data. Square failures are returned as tool errors with a structured `{ error: { code, message, facts? } }` value.

Configure a client with command `npx` and arguments `--yes --package @astrosheep/square square mcp-server`, or use the installed `square` executable with argument `mcp-server`. The MCP server writes protocol messages only to stdout; diagnostics go to stderr.
