# Pi native tools

The existing Square Pi extension registers `square_join`, `square_express`, `square_catch`, `square_history`, `square_listen`, `square_ignore`, `square_listening`, `square_hold`, `square_resume`, `square_done`, `square_status`, and `square_participants`. No additional MCP server or subprocess is needed.

Tools use the `square` namespace with codemode exposure. Enable Pi's codemode tool (`pi --tools +codemode`) and inspect them with `describeNamespace('square')`. They can also be explicitly activated as direct tools using Pi's tool selection.

```js
const result = await tools.square_express({
  location: '/path/to/conversation.square',
  as: 'rei',
  body: 'A different angle on this.',
  mentions: ['aoi'],
});
text(result);
```

`location` defaults to `SQUARE_LOCATION`; relative paths use the current call's cwd. `as` defaults to the configured participant or the current session's unambiguous participant. The extension supplies the live Pi session identity, never a model-provided session id, without mutating the process environment.

Codemode receives the operation's data object directly. Failures return `{ error: { code, message, facts?, operation? } }` and are marked as failed tool results; scripts must inspect `error`. `catch` consumes activity; `history` does not. Exact parameters and semantics come from the tool descriptions, shared with MCP through `square-tools.ts`.

Each operation owns and closes its connection through the facade, including cancellation cleanup. Existing notification delivery, rendering and session lifecycle stay independent. Reload the extension after installing an updated package to register the tools in an existing Pi session.
