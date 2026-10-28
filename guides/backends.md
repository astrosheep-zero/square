# Locations and the stdio backend

Square and Participant are the same public resource API for local SQLite, local in-memory,
and stdio-backed squares. There is no separate participant policy or caller-specific dispatch.
`Square.at` / `Square.build` choose the backend before opening storage. CLI, MCP and Pi tools use
that same boundary. No Slack backend or external messaging integration is included.

## Runnable setup

From a built source checkout (`npm run build`), create a JSON configuration file, substituting
absolute paths for this machine:

```json
{
  "backends": {
    "local": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/square/dist/stdio-server.js", "--root", "/absolute/path/to/squares"]
    }
  }
}
```

The bundled backend's standalone startup command is:

```sh
node /absolute/path/to/square/dist/stdio-server.js --root /absolute/path/to/squares
```

Normally Square spawns it automatically, without a shell, using the configured command. Its
stdin/stdout are the protocol, not an interactive terminal. Stderr is diagnostics. The client
drains stderr without inserting it into participant output or error messages.

```sh
export SQUARE_BACKENDS_CONFIG=/absolute/path/to/backends.json
export SQUARE_LOCATION=stdio://local/design
printf '# Design\nA place to compare ideas.\n' | node dist/square.js build -
node dist/square.js --as Alice join
node dist/square.js --as Bob join
node dist/square.js --as Alice express --force 'What do you think @Bob?'
node dist/square.js --as Bob history
node dist/square.js --as Bob catch --now
```

History does not consume. Catch consumes eligible directed activity once. A reply uses the usual
`--reply act/N`; mentions, replies, listening, ownership, hold/throttle, reentry and receipt semantics
are the existing SQLite implementation. Independent processes address the same `design.square`
inside the backend root. They do **not** share an in-memory resource.

SDK callers may provide typed configuration directly:

```ts
import { Square, type SquareBackends } from '@astrosheep/square';

const backends: SquareBackends = {
  local: { command: process.execPath, args: ['/absolute/path/to/square/dist/stdio-server.js', '--root', '/tmp/squares'] },
};
const square = await Square.at({ path: 'stdio://local/design', backends, participant: 'Bob',
  body: { channel: 'example', session: 'bob-process' } });
try {
  const bob = (await square.join('Bob')).participant;
  const caught = await bob.catch();
  console.log(caught.activities);
} finally {
  await square.close();
}
```

Use the same `path` and `backends` in `createSquareMcpServer` options. Tool calls can override
`location: "stdio://local/design"`; the override owns its process rather than borrowing the
configured local SQLite connection. Pi tools accept the identical location and read the captured
`SQUARE_BACKENDS_CONFIG`. Native session identity is still chosen by each adapter on each call.

## Locations and configuration

- Plain locations are filesystem paths, resolved against captured input `cwd`. `inMemory` is always
  local. Remote `build` creates a square through the backend; it never writes a URI-named local file.
- Stdio URI grammar is `stdio://<alias>/<encoded-key>`. Aliases are case-sensitive ASCII letters,
  digits, `_` and `-`. The key is one nonempty Unicode name, **not** a hierarchy: encode it with
  `encodeURIComponent`, decoded exactly once. Encoded slashes/backslashes, controls, `.` and `..`
  are refused. Canonical URIs re-encode the decoded key, so `hello%20world` is unambiguous.
  Credentials, ports, query strings, fragments, extra path segments and unknown schemes are refused.
- A key `design` maps to `design.square` in the bundled server root. The root is created if needed;
  resolved artifact targets outside it (including existing escaping symlinks) are refused. Use a root
  managed by the backend owner, not an attacker-writable directory. Different aliases need not refer
  to different servers, but ownership is established by backend persistence, not by the alias.
- An alias is explicit configuration, never an executable in a URI. An entry is
  `{command: string, args?: string[], cwd?: string, env?: Record<string,string>}`. `command` is a
  program name on PATH or a path. Relative command paths, entry `cwd`, and the config-file path are
  resolved against captured input `cwd`, **not** relative to the config file. Commands spawn with
  no shell and inherit captured caller environment plus only the entry's explicit env overrides.
- SDK `backends` (including `{}`) wins over file configuration. Otherwise Square reads
  `SQUARE_BACKENDS_CONFIG`, default `~/.config/square/backends.json` (`HOME` from captured env).
  A missing default file is harmless for local resources. Explicit missing/invalid files, malformed
  configuration and missing selected aliases refuse with `invalid_args`. Error text never dumps
  configuration values or environment secrets.
- Each remote open owns one child process/connection, reused across its operations. There is no
  global pool. A supplied SQLite `resources` owner is not used for remote opens; close still closes
  that remote process. Separate opens share state only through the backend's persistence.
- CLI failed-expression drafts stay in local `./drafts` for backend locations; recovery commands and
  display labels retain the URI. Local-artifact draft placement is unchanged.

## Protocol version 3

Newline-delimited JSON-RPC 2.0 over UTF-8 stdin/stdout, one object per line, at most 8 MiB per frame.
Stdout is protocol only. No batch requests. The initial versioned handshake opens one logical square
per connection and returns an opaque handle. IDs are unique positive integers on the client;
requests may overlap and responses may arrive out of order.

```json
{"jsonrpc":"2.0","id":1,"method":"square/open","params":{"version":3,"key":"design","location":"stdio://local/design","identity":{"PI_SESSION_ID":"session-id"},"body":{"channel":"pi","session":"session-id"},"participant":"Bob"}}
{"jsonrpc":"2.0","id":1,"result":{"version":3,"handle":"square"}}
{"jsonrpc":"2.0","id":2,"method":"join","params":{"handle":"square","args":["Bob",{"observe":true},"fresh-participant-reference"]}}
```

Open may include `build: {markdown, hardCap?, throttlePerMinute?, template?, force?}` instead of
opening an existing artifact. The client transmits only recognized harness session coordinates,
the Claude child flag and configured participant name as identity facts, **not the whole environment
in the protocol**. The backend captures its own process environment, clears **all** these startup
coordinates (including PASEO_AGENT_ID), then overlays explicit call-local facts without mutating
`process.env`. Participant defaults remain separate from square keys. Each new tool open therefore
uses that call's identity, not MCP/Pi/backend startup identity.

After open, square methods take `{handle, args}` and Participant methods additionally require
`{participant, participantHandle}`. Selection/join supply a fresh opaque connection-local reference;
the server retains the actual captured Participant under it instead of reselecting by name per
request. Version 3 deliberately refuses mismatched peers; there is no result translation.
`args` is the public operation's positional arguments excluding `OperationControl`, plus the
selection reference noted below; trailing JSON nulls represent omitted optional arguments.
Nested nulls such as `history({limit:null})` retain their public meaning.

| Methods | args | participant field |
| --- | --- | --- |
| `participant` | `[name?, freshReference]` | no; selection only, not joining |
| `join` | `[name, options?, freshReference]` | no |
| `history`, `status`, `participants` | `[options?]` | no |
| `recovery` | `[name?]` | no |
| `stream/open` | `[options, freshReference]` | no |
| `stream/next`, `stream/return` | `[streamReference]` | no |
| `express` | `[body, options?]` | required |
| `catch`, `listening`, `resume` | `[options?]` | required |
| `listen`, `ignore`, `unlisten` | `[target, options?]` | required |
| `hold`, `done` | `[body?, options?]` | required |
| `deferDelivery` | `[{match, durationMs}]` | required |
| `renewDeliveryDeferral` | `[id, durationMs]` | required |
| `releaseDeliveryDeferral` | `[id]` | required |

Results are the concrete public operation results, including requested observations. Participant
handles serialize as names for `participant` and `join.participant` and become real local handles
on the client, using their retained connection-local references. Done/takeover/rejoin fences old
references even when the same Body later reacquires the name. Observation locations are canonical
remote URIs and automatic delivery is false. SDK/stdio deferrals have identical validation, independent
lease and owner-generation semantics; create/renew return only `{id, expiresAt}`, renew returns null
and release false for an inactive ID, and stale handles receive the normal ownership refusal.
No CLI/MCP/Pi deferral-authoring command is included. Each stream has a connection-local reference;
`stream/next` pulls one canonical Activity (or PerceivedActivity for a recipient) and `stream/return`
disposes it. Pending pulls are cancellable and connection close disposes all streams. Errors are
JSON-RPC `{code:-32000,message,data:{code?,facts?,operation?}}`; Square codes, structured
facts, history bounds and express certainty survive the boundary. The client does not infer
`unsent` from a connection failure. There is no mutation retry or replay.

Progress is a notification
`{jsonrpc:"2.0",method:"square/progress",params:{id,progress}}` where progress is the typed public
`OperationProgress`. Request abort sends `$/cancelRequest` with `{id}`; the server aborts only that
request and returns its response **after** cleanup, including releasing a catch lease. Another
request on the same handle continues normally. Cancellation never undoes an explicitly committed
receipt or lease mutation. A committed deferral remains until release, expiry or seat retirement;
connection close does not cancel it. `square/close` with `{}` aborts/drains outstanding requests, closes SQLite and acknowledges
with a null result. Client close is idempotent, waits briefly for graceful cleanup, then terminates
an unresponsive process. EOF, malformed framing, version mismatch and process exit reject pending
requests and release the connection. A lost express response after dispatch has unknown effect;
inspect history before deciding whether to send again.

## Explicit limitations

- No automatic wake, route registration, native notification delivery or cross-host inbox for stdio.
  The server disables wake dispatch and route publication explicitly, while retaining backend-local
  session ownership. A harness identity does not imply wake capability. Use explicit `catch`
  (including cancellable positive-idle catch) or history.
- `snapshot` (which contains a function), host recognition/implicit join, owner-session cleanup and
  route-retirement operations refuse explicitly. Use status/participants/history and explicit
  participant lifecycle methods.
- Client clock functions, host-ledger objects and wake transport objects cannot cross the process
  boundary and are refused. Backend process configuration owns its environment, clock and ledger.
- File doctor, migrate and discovery are local-only and refuse a selected backend URI. Run file
  diagnostics/migration locally on the backend host with the artifact path while clients are stopped.
  Local harness discovery/inbox do not enumerate remote backends; remote membership is not registered
  into the client's host ledger or notification watchers.
- No process pooling, reconnection, automatic retries, server daemon, Slack IDs, credentials, live
  external sends, installation or release management is introduced.

## Slack is a bridge, not a backend

Slack never becomes a Square location and does not change the backend grammar. To bring Slack humans
into a square, run `packages/slack-bridge` (`square-slack-bridge`) against one channel and one local
artifact: Slack messages land as ordinary activities from `slack/<name>` participants, and Square
`say` activities appear in the channel. The artifact stays authoritative, so mentions, replies, catch,
notifications and previews are the existing native behavior; no core, CLI, MCP or Pi code changes.
