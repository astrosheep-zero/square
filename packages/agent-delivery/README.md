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
npm install @astrosheep/agent-delivery@0.1.2
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

The independent leaf is `@astrosheep/agent-delivery/codex-hook`:

```js
import { createCodexBoundaryStore, handleCodexHook, codexIdleAtStop } from '@astrosheep/agent-delivery/codex-hook'

const boundaries = createCodexBoundaryStore('/private/your-host/codex-boundaries.json')
const result = await handleCodexHook(inputFromCodex, {
  boundaries,
  pull: async (sessionId, signal, event) => takePendingText(sessionId, signal, event),
  interrupt: async (sessionId, signal) => cancelCapturedBatch(sessionId, signal),
})
// Write a defined result as one JSON line. A host with its own output sink must
// accept that output before it records presentation evidence.
```

Install synchronous SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop,
Interrupt and SessionEnd handlers. Only the three active prompt/tool boundaries
pull text into event-correct `additionalContext`. Stop requires `turn_id` and
records a unique `{token, turnId}` epoch; it never sweeps or sends. Active and
lifecycle events disarm. End blocks late callbacks until a new SessionStart.
SessionResume is not a verified 0.166.0 hook and is not supported as coverage.
Old or malformed boundary files cannot authorize a queue.

The host owns pending cards, attachment generation, claims, cancellation,
observation and any native async Stop watcher. The package invents no session,
inbox or daemon. The synchronous handler defaults to a 4.5-second cooperative
budget. `pull` is awaited through post-effect settlement even if cancellation
arrives later; do not discard a real presentation or rewrite it as unsent.

For idle delivery, capture the current epoch and use
`codexIdleAtStop({harness:'codex',sessionId,endpoint,codexHome,signal,timeoutMs}, epoch.turnId)`.
It uses the existing app-server connection and live `thread/read(includeTurns:true)`
to require idle plus the exact newest completed turn. Newest-last ordering is
verified for native 0.166.0 only; an unsupported server version, unavailable
endpoint or unverifiable history returns false. This is a read, never a turn
start, resume or queue operation. Recheck after acquiring custody, then exact
epoch equality via `boundaries.queueEligible(sessionId, epoch)` and the host's
final generation/cancellation/suppression fence immediately before invoking queue.

```js
import { connect } from '@astrosheep/agent-delivery'
const agent = await connect({
  harness: 'codex', transport: 'cli', sessionId: threadId,
  boundaries: { queueEligible: async id =>
    await codexIdleAtStop({ harness: 'codex', sessionId: id, endpoint }, epoch.turnId) &&
    await boundaries.queueEligible(id, epoch) && await claimStillCurrent() },
  codexHome: '/recipient/.codex', endpoint,
})
await agent.queue('Exact input', { timeoutMs: 5000 })
```

The CLI binds `queueEligible` once and calls it just before each child launch.
Hosts must provide their final custody fence there; a boundary boolean alone
cannot prove native idle. `connect()` only binds CLI coordinates locally. An
ineligible source rejects known-unsent with `DeliveryError('session_inactive')`.
By default this standalone CLI leaf permits normal native connection/startup;
only explicit `endpoint` adds `--remote`. Receiver watchers should specify the
already-hosting endpoint. `codexHome`, `bin`, `args` and `env` are captured at
connection time. CLI has queue only; receipt ids are local correlation, not
native message ids or idempotency keys.

A successful queue proves admission, never presentation. After child launch,
timeout, abort and unexplained exit are unknown and cannot be blindly retried.
Cancellation can terminate the child but cannot recall an admitted input. Native
idle reads and external queue are not atomic: a new turn may begin between the
last check and RPC. A host-owned watcher also needs explicit recovery policy:
Square starts observation at first Stop with a finite 86400-second native async
budget, and after crash/timeout while otherwise idle cards wait for another
native boundary. No producer fallback restores that coverage.

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
