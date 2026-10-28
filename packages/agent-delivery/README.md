# @astrosheep/agent-delivery

One-way plain-text delivery into an existing agent session. No replies, no
completion or status checks, no automatic retry. Native `connect` transports
never start services; Codex `transport: 'cli'` allows normal CLI startup unless
an explicit remote endpoint is supplied. Both use `connect()` and capability methods.

| Harness | `steer` | `queue` | Caller id | Receipt proof | Platforms |
| --- | --- | --- | --- | --- | --- |
| Codex app-server | busy only | yes | — | `admitted` — native RPC admission | Unix socket: macOS/Linux; WebSocket: any |
| Codex CLI | — | yes | — | `admitted` — CLI queue succeeded | installed Codex CLI |
| OpenCode | yes | yes | yes (`id`) | `admitted` — durable inbox admission | any |
| Claude | yes | — | — | `written` — local socket bytes | darwin, linux, win32 |
| Pi | yes | yes | — | `observed` — correlated `message_end` | darwin |
| Paseo | yes | — | yes (`id`) | `admitted` — daemon admitted the message | darwin, linux, win32 |

A capability is a method: `'queue' in agent` is `false` for Claude and Paseo;
`'steer' in agent` is `false` for Codex CLI.
Receipts do not prove model consumption, completion or human display, and an
unconfirmed attempt may still arrive. See [VALIDATION.md](VALIDATION.md) for
tested versions.

A Paseo steer always asks the daemon to steer the active turn and never to
interrupt it. A provider that cannot steer an active turn may replace it
instead; both outcomes are reported as `admitted`.

## Install and connect

```sh
npm install @astrosheep/agent-delivery@0.1.1
```

For local development, run `npm ci`, `npm test` and `npm pack` in
`packages/agent-delivery`, then install the generated tarball in your consumer.

```js
import { connect } from '@astrosheep/agent-delivery'
import { createCodexBoundaryStore } from '@astrosheep/agent-delivery/codex-hook'

// Codex CLI: bind the same lifecycle source used by the receiver's hooks, once.
const codexCli = await connect({
  harness: 'codex',
  transport: 'cli',
  sessionId: 'existing-thread-id',
  boundaries: createCodexBoundaryStore('/private/your-host/codex-boundaries.json'),
  codexHome: '/recipient/.codex',
})
await codexCli.queue('Next fresh input') // Checks lifecycle internally; no steer method.

// Codex app-server: connect to the server already hosting this thread; never starts or resumes it.
const codex = await connect({
  harness: 'codex',
  transport: 'app-server', // Default when omitted; never falls back to CLI.
  sessionId: 'existing-thread-id',
  // Optional; defaults to <CODEX_HOME ?? ~/.codex>/app-server-control/app-server-control.sock.
  endpoint: '/absolute/path/to/app-server-control.sock',
  // For an authenticated ws:// or wss:// endpoint: token: process.env.CODEX_TOKEN,
})
await codex.queue('Next fresh input')
// Only while a steerable turn is active; idle is rejected, not silently queued.
await codex.steer('Exact text for the active turn')

// OpenCode: an existing 2.x service and a persisted session.
const opencode = await connect({
  harness: 'opencode',
  sessionId: 'ses_existing',
  // Optional; otherwise the registered service is discovered.
  endpoint: {
    url: 'http://127.0.0.1:12345',
    auth: { type: 'basic', username: 'opencode', password: process.env.OPENCODE_PASSWORD },
  },
})
const receipt = await opencode.steer('Exact plain text', { id: 'msg_stable_id' })
await opencode.queue('Next fresh input', { id: 'msg_second' })

// Claude: an explicit session id and native inbox endpoint.
const claude = await connect({
  harness: 'claude',
  sessionId: 'receiver-current-session-id',
  endpoint: '/absolute/path/from/receiver/native.sock',
})
await claude.steer('Plain text for the next boundary.')

// Pi: an explicit session id and extension socket.
const pi = await connect({ harness: 'pi', sessionId: 'actual-existing-id', endpoint: '/private/delivery/p.sock' })
await pi.steer('/literal text\n  unchanged 🦈')

// Paseo: a running daemon and an existing agent.
const paseo = await connect({
  harness: 'paseo',
  agentId: 'existing-agent-id',
  // Optional; otherwise PASEO_HOST and then the daemon's own address.
  endpoint: 'tcp://127.0.0.1:6767',
  // Optional; otherwise the local credential file and then PASEO_PASSWORD.
  password: process.env.PASEO_PASSWORD,
})
const steered = await paseo.steer('Exact plain text', { id: 'msg_stable_id' })
```

Every successful send resolves `{ id, proof }`. `id` is the caller id or the
generated `msg_<uuid>` (OpenCode), the frame `msg_id` (Claude), the attempt id
(Pi), the generated native correlation UUID (Codex app-server), a local attempt
UUID (Codex CLI), or the caller id or the generated UUID (Paseo). Agents are frozen plain
objects; `steer`/`queue` take `{ timeoutMs, signal }`, and OpenCode and Paseo
additionally take a caller `id`.

### Codex app-server

`connect` addresses an existing thread using `thread/read`. Each call opens a
WebSocket connection, initializes the experimental API, and closes the connection
when done. Absolute Unix socket paths and `unix://` use WebSocket-over-UDS, not raw
NDJSON; `ws://` and `wss://` accept an optional Bearer `token`. `codexHome` overrides
`CODEX_HOME` for default local endpoint discovery. No service is started, no
thread is resumed, and a private stdio-only app-server is not externally reachable.

Steer discovers the active turn and fences `turn/steer` with `expectedTurnId`;
idle/stale/non-steerable turns reject without falling back to queue. Queue calls
`thread/queue/add`. Admission does not guarantee immediate execution: an unloaded
or interrupted thread can remain queued. The generated UUID is correlation only,
not an idempotency key. Mutation-time timeout, abort, disconnect or malformed
acknowledgement is unknown (`DeliveryError.maybeDelivered === true`); do not
blindly resend. There is no consumption subscription, history polling or read
receipt. Exact runtime evidence and platform limits are in `VALIDATION.md`.

### Codex hook + Stop queue

The independent hook leaf is `@astrosheep/agent-delivery/codex-hook`:

```js
import { createCodexBoundaryStore, handleCodexHook } from '@astrosheep/agent-delivery/codex-hook'

const boundaries = createCodexBoundaryStore('/private/your-host/codex-boundaries.json')
const result = await handleCodexHook(inputFromCodex, {
  boundaries,
  pull: async (sessionId, signal) => takePendingText(sessionId, signal),
  sweep: async (cwd, deadline, signal) => dispatchPending(deadline, signal),
})
// Write result as one JSON line to the hook's stdout only when defined.
```

`inputFromCodex`, `takePendingText` and `dispatchPending` belong to the host:
the package does not create an inbox, invent message text, or acknowledge host
business records. Install the host's command for `SessionStart`, `SessionResume`,
`UserPromptSubmit`, `SessionEnd`, `PostToolUse` and `Stop`. Only `PostToolUse`
pulls text into `additionalContext`; Stop records queue eligibility and asks the
host to sweep. Start/resume/new prompts clear Stop eligibility; end records an
ended marker, blocking queue even if a late Stop/tool callback arrives. Only a
new start/resume reopens it. The hook's cancellation budget defaults to 4.5 seconds;
callbacks receive its abort signal. Before presenting or sending, hosts must honor
cancellation and release uncommitted claims. `pull` is cooperatively awaited, not
raced against that budget: once a host has presented, it must finish any
cancellation-independent evidence settlement and return the associated text even
if the signal aborts meanwhile. Otherwise it should resolve `undefined` or reject
after cancelling its uncommitted work. A `pull` that ignores cancellation can hold
the hook open; hosts must leave enough time for settlement within the harness's
external hook timeout. The handler never abandons an in-flight pull and discards
its committed output. Sweeps remain bounded by the hook budget, are skipped after
expiry, and cannot erase a successful pull's response.

For still-pending work, bind that lifecycle source at connection time:

```js
import { connect } from '@astrosheep/agent-delivery'
const agent = await connect({
  harness: 'codex', transport: 'cli', sessionId: threadId, boundaries,
  codexHome: '/recipient/.codex',
})
await agent.queue('Exact input', { timeoutMs: 5000 })
```

`boundaries` can be the shared file store or a host-owned object implementing
`queueEligible(sessionId): Promise<boolean>`. The client binds it once and checks
it exactly once inside each `queue()`, before launching a child. The host still
owns its business currentness/claim gate; it does not manually repeat the
lifecycle check. An ended, unknown or non-Stop session rejects with
`DeliveryError('session_inactive')`, known-unsent. `connect()` only binds CLI
coordinates locally; unlike app-server connect it does not probe thread existence
or launch a process. The hook source establishes lifecycle eligibility, not
proof of current native ownership.

By default the CLI uses its normal connection/startup behavior; only explicit
`endpoint` adds `--remote`. `codexHome` (otherwise captured `CODEX_HOME`/home),
`bin`, `args` and `env` configure the bound child. CLI clients expose `queue`
only. Successful queue returns `{ id, proof: 'admitted' }`; its id is local attempt
correlation, not a native message id or idempotency key. A post-launch timeout,
abort or unexplained exit is `DeliveryError` with `maybeDelivered: true`, never an
automatic retry. The CLI runs asynchronously so abort can terminate a pending
child. A previously launched input cannot be retracted by a later SessionEnd.
The low-level CLI sender is internal, not another public sending interface.

Use one host-owned pending/claim path for pull and queue, rather than submitting
the same work through both. Without a tool boundary, a busy receiver must wait
until Stop; this mechanism is not immediate native steer. Square uses these same
leaves and retains only its activity selection, rendering, cancellation and
membership policy. No Square dependency is required by another host.

### OpenCode

Default discovery uses the official SDK against
`${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json`. `endpoint` and
`registrationFile` are mutually exclusive. Send calls
`session.prompt({sessionID, text, delivery, id, resume: true})` once. Steer enters
at a step boundary; queue waits for a fresh-input boundary. A reused caller `id`
returns the first native admission, so reuse it only for the same logical input.

### Claude

`endpoint` is a Unix socket path or, on Windows, a named pipe (`\\.\pipe\name`;
case-insensitive, `\\?\pipe\LOCAL\name` accepted). The write is one NDJSON user
frame, preceded by an auth frame when a token resolves:

1. an explicit `token`
2. `CLAUDE_CODE_MESSAGING_TOKEN` when `CLAUDE_CODE_MESSAGING_SOCKET` names the same endpoint
3. the newest readable peer key for that endpoint under `<claudeHome>/sessions` (`claudeHome`, `CLAUDE_CONFIG_DIR`, then `~/.claude`)

Windows requires a token and fails with `authentication_failed` before any I/O;
on macOS and Linux a tokenless write is unchanged.

### Pi

The receiver ships with the package and is registered inside an existing Pi
extension; registration opens nothing.

```js
import { createPiReceiver, sendPiMessage } from '@astrosheep/agent-delivery/pi-receiver'

export default function extension(pi) {
  pi.registerFlag('agent-delivery-socket', { type: 'string', description: 'Private local socket' })
  const receiver = createPiReceiver(pi, { get endpoint() { return pi.getFlag('agent-delivery-socket') } })
  // In-process sends: sendPiMessage(pi, message, nativeOptions).
}
```

The endpoint must be an absolute Unix socket under a caller-owned `0700`
directory. Socket mode is `0600`; occupied paths fail closed; replacement
retires connections and old targets. Steer maps to native steer, queue to
`followUp`, both with `triggerTurn: true`; text is passed unchanged.

### Paseo

`agentId` may be a full id, a unique prefix or an exact title. `endpoint` accepts
the daemon spellings the Paseo CLI accepts (`unix://`, `pipe://`, `tcp://`,
`\\.\pipe\…`, a bare port, `host:port`); otherwise `PASEO_HOST` and then the
daemon's own recorded listen address are used, falling back to
`127.0.0.1:6767`. Credentials resolve in order: an explicit `authHeader`,
`password` or `localCredential`; the readable
`<paseoHome ?? PASEO_HOME ?? ~/.paseo>/local-credential`; `PASEO_PASSWORD`; then
an unauthenticated attempt. Every send carries the caller `id` as the daemon's
`messageId` and always asks for `steer`. Each call opens and closes its own
daemon connection, so a one-shot caller's process is free to exit as soon as it
is done.

## Errors

Every failure rejects with `DeliveryError` (`name`, `code`, `maybeDelivered`,
optional `id` and `status`). Messages carry no endpoint, token or body.

| Code | Meaning | `maybeDelivered` |
| --- | --- | --- |
| `invalid_arguments` | Bad arguments, rejected before I/O | `false` |
| `unsupported_platform` | This transport does not run here | `false` |
| `unavailable` | Endpoint or service unavailable; nothing was written | `false` |
| `authentication_failed` | Missing or refused credentials, before I/O | `false` |
| `session_not_found` | The receiving service has no such session | `false` |
| `session_inactive` | The bound Codex CLI lifecycle source has no eligible Stop | `false` |
| `rejected` | The receiver refused the delivery | `false` |
| `unsupported_version` | The receiving service version is unsupported | `false` |
| `invalid_response` | The receiver answered with an unusable response | `false` |
| `timeout` | The deadline expired | `true` once bytes may have been written |
| `aborted` | The caller aborted | `true` once bytes may have been written |
| `transport` | The connection failed mid-delivery | `true` once bytes may have been written |

`timeoutMs` defaults to 5 seconds and must be finite and positive; `signal` must
be an `AbortSignal`. A pre-aborted call writes nothing.
