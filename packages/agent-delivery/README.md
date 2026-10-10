# @astrosheep/agent-delivery

One-way plain-text delivery into an existing agent session. No replies, no
completion or status checks, no automatic retry, no service startup.

| Harness | `steer` | `queue` | Caller id | Receipt proof | Platforms |
| --- | --- | --- | --- | --- | --- |
| OpenCode | yes | yes | yes (`id`) | `admitted` — durable inbox admission | any |
| Claude | yes | — | — | `written` — local socket bytes | darwin, linux, win32 |
| Pi | yes | yes | — | `observed` — correlated `message_end` | darwin |

A capability is a method: `'queue' in agent` is `false` for Claude. Receipts do
not prove model consumption, completion or human display, and an unconfirmed
attempt may still arrive. See [VALIDATION.md](VALIDATION.md) for tested versions.

## Install and connect

The package is not published. Build a local tarball and install it:

```sh
cd packages/agent-delivery
npm ci
npm test
npm pack
npm install /absolute/path/to/astrosheep-agent-delivery-0.1.0.tgz
```

```js
import { connect } from '@astrosheep/agent-delivery'

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
```

Every successful send resolves `{ id, proof }`. `id` is the caller id or the
generated `msg_<uuid>` (OpenCode), the frame `msg_id` (Claude), or the attempt id
(Pi). Agents are frozen plain objects; `steer`/`queue` take `{ timeoutMs, signal }`,
and OpenCode additionally takes a caller `id`.

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
| `rejected` | The receiver refused the delivery | `false` |
| `unsupported_version` | The receiving service version is unsupported | `false` |
| `invalid_response` | The receiver answered with an unusable response | `false` |
| `timeout` | The deadline expired | `true` once bytes may have been written |
| `aborted` | The caller aborted | `true` once bytes may have been written |
| `transport` | The connection failed mid-delivery | `true` once bytes may have been written |

`timeoutMs` defaults to 5 seconds and must be finite and positive; `signal` must
be an `AbortSignal`. A pre-aborted call writes nothing.
