# @astrosheep/agent-delivery

Existing-session plain-text delivery, independent of Square. ESM; Node
`^22.16.0 || >=24.0.0`. No service startup or automatic retry.

| Harness | Coordinate | Delivery | Strongest receipt |
| --- | --- | --- | --- |
| OpenCode | Existing service + persisted session | `steer` (default), `queue` | `accepted`: durable inbox admission |
| Claude | Explicit session ID + native socket | `steer`/native `next` | `written`: local bytes |
| Pi | Explicit session ID + extension socket | `steer` (default), `queue` | `observed`: correlated `message_end` |

Receipts do not prove completion or human display. Unknown attempts may still
arrive. See [VALIDATION.md](VALIDATION.md) for tested versions and reproducers.

## Install and send

The package is not published. Build a local tarball and install it in a consumer:

```sh
cd packages/agent-delivery
npm ci
npm test
npm pack
# In the consumer directory:
npm install /absolute/path/to/astrosheep-agent-delivery-0.1.0.tgz
```

Its runtime dependency is official `@opencode/client@2.0.20`, including its
upstream dependency graph. The main API loads only the selected adapter;
`./opencode-native`, `./claude-native` and `./pi` do not load the OpenCode SDK.

```js
import { connectExisting, sendText } from '@astrosheep/agent-delivery'
const target = await connectExisting({ harness: 'opencode', sessionId: 'ses_existing' })
const receipt = await sendText(target, 'Exact plain text', { delivery: 'steer' })
```

Handles are frozen coordinates private to this package instance, not
serializable. Text must be nonempty. Invalid send arguments throw a fixed-message
`TypeError` before I/O. Results expose caller session/input IDs and fixed codes,
never endpoints, credentials, text, server bodies or raw SDK errors.

## OpenCode

Default discovery uses official `Service.discover({file, version: is2x})` and
`${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json`. The SDK checks
registration, PID, version and Basic auth. Supply an absolute `registrationFile`
or an explicit endpoint; the two options are mutually exclusive:

```js
const target = await connectExisting({
  harness: 'opencode', sessionId: 'ses_existing',
  endpoint: {
    url: 'http://127.0.0.1:12345',
    auth: { type: 'basic', username: 'opencode', password: process.env.OPENCODE_PASSWORD },
  },
})
const receipt = await sendText(target, 'text', { delivery: 'queue', inputId: 'msg_stable_id' })
```

Auth is optional. HTTP(S) base paths are allowed; userinfo/query/fragment are
not. Adapter requests reject redirects; SDK discovery owns its probe behavior.
Connect checks `/api/info` for 2.x and resolves `session.get`; a persisted session
does not prove an attached TUI. The tested baseline is 2.0.20, not all 2.x builds.

Send invokes `session.prompt({sessionID, text, delivery, id, resume: true})` once.
Steer enters at a step boundary without interrupting work; queue waits for a
fresh-input boundary. Both wake idle sessions.

- `accepted`: matching native receipt with session/input ID, delivery, payload
  shape and creation time; includes `inboxId`. Prompt hooks may transform text.
- `unknown`: unconfirmed dispatch, including timeout, abort, transport loss,
  malformed success and server failure. A 5xx may follow durable admission.
- `rejected`: HTTP 400/401/403/404/409, even with an unreadable body; includes
  bounded `status` and `http_rejection`.
- `unavailable`: stopped before dispatch.

Receipts include `harness`, `sessionId`, `inputId`. Omitted IDs become `msg_<UUID>`;
caller IDs require `msg_`. Native first-admission-wins includes promoted inputs
and does not compare text: reuse an ID only for the same logical input. Pending
inbox inspection cannot settle promoted inputs. Historical event replay is not
recovery. There is no watch, cancellation or completion API.

Embeddings with an existing native capability can use `connectNative`,
`sendNativeText` and `createNativeInputId` from `./opencode-native`. This leaf
accepts structural `session.get`/`session.prompt`, without discovery or SDK loading.

## Claude

Validated on macOS Claude Code 2.1.295. Callers establish the receiver version;
the socket protocol cannot interrogate it. Other platforms are unsupported.

```js
const target = await connectExisting({
  harness: 'claude', sessionId: 'receiver-current-session-id',
  endpoint: '/absolute/path/from/receiver/native.sock',
})
const receipt = await sendText(target, 'Plain text for the next boundary.')
```

Connect checks that the explicit path is a socket and sends nothing; it cannot
prove listener liveness, conversation ownership or policy approval. Native
permissions and inbound policy apply. No credentials or sender authority are
forwarded. Queue and caller input IDs are unsupported and reject before write.

Send writes tokenless UTF-8 NDJSON, `msgV:1`, `priority:'next'`, targeted session
ID and a fresh UUID. `written` means local bytes, without admission acknowledgment;
`unknown` means connected I/O lost, aborted or timed out; `unavailable` means
not sent before connection. Receipts have `harness` and `sessionId`, no input ID.
EOF and absence of refusal never establish admission.

Square uses the same low-level transport; plain peers need no Square mod:

```js
import { writeClaudeNative } from '@astrosheep/agent-delivery/claude-native'
const result = await writeClaudeNative(
  { sessionId: 'receiver-id', endpoint: '/absolute/native.sock' },
  'plain text', { deadline: Date.now() + 5000, signal: controller.signal },
) // outcome: written | unknown | unavailable
```

This leaf owns framing and bounded I/O. Its caller establishes capability;
Square owns lifecycle, correlation and stored-context presentation evidence.

## Pi

Register the receiver inside an existing extension:

```js
import { createPiReceiver, sendPiMessage } from '@astrosheep/agent-delivery/pi'
export default function extension(pi) {
  pi.registerFlag('agent-delivery-socket', { type: 'string', description: 'Private local socket' })
  const receiver = createPiReceiver(pi, {
    get endpoint() { return pi.getFlag('agent-delivery-socket') },
  })
  // In-process sends: sendPiMessage(pi, message, nativeOptions).
}
```

Registration opens nothing. `session_start` reads the lazy endpoint getter and
actual `ctx.sessionManager.getSessionId()`. Missing endpoint is inert; identical
starts are idempotent. Replacement retires connections and old targets. Shutdown
closes resources; hosts that omit `session_shutdown` must await `receiver.close()`.
Session identity is never invented or overwritten.

The macOS endpoint must be an absolute Unix socket, at most 103 UTF-8 bytes,
with room for a short sibling name in a caller-owned `0700` parent. Socket mode
is `0600`; occupied paths fail closed. Atomic hard-link publication and inode
checks protect replacement endpoints from Node's bind-path unlink. No discovery,
parent chmod or stale-file reclamation occurs.

```js
const target = await connectExisting({
  harness: 'pi', sessionId: 'actual-existing-id', endpoint: '/private/delivery/p.sock',
})
const receipt = await sendText(target, '/literal text\n  unchanged 🦈', { delivery: 'queue' })
```

Text is unchanged. Messages use `customType:'agent-delivery'`, `display:true` and
fresh UUID `details.agentDelivery.deliveryId`. Returned `inputId` is not
idempotency; caller IDs reject. Steer maps to native steer, queue to followUp,
both with `triggerTurn:true`. `sendPiMessage` passes in-process objects/options
unchanged to one native call.

- `observed`, `evidence:'message_end'`: active-session event matches type, text
  and attempt metadata. Pi 1.1.0 emits it before final append; it is not durable
  admission or a guarantee under other extensions rewriting events.
- `unknown`: write/dispatch may have occurred without matching observation.
- `rejected`: pre-injection `wrong_session`, `invalid_request` or `duplicate_inflight_id`.
- `unavailable`: stopped before write.

Bounds: 64 connections, 256 KiB LF JSON frames, 128 KiB UTF-8 text, 5 seconds
for partial frames/response flush and at most 30 seconds for correlation.
Malformed frames never inject. Disconnect retires waiters; abort and cleanup
never retract native custody or call native abort/clearQueue. No polling,
append tracking or replay. Square ships this receiver in its existing extension
and keeps its own audience, presentation and cancellation policy.

## Deadlines and errors

Default total timeout is 5 seconds, including response waiting. `timeoutMs` must
be finite and positive: Pi maximum 30 seconds; OpenCode/Claude maximum
`2_147_483_647` (Node timer range). `signal` must be an AbortSignal. Preabort
sends nothing. Late SDK discovery results never continue into lookup or send.

`connectExisting` throws exported `ConnectionError` with a fixed `code`:
`invalid_arguments`, `aborted`, `timeout`, `service_unavailable`,
`unsupported_version`, `unsupported_platform`, `authentication_failed`,
`session_not_found`, `http_rejection` or `invalid_response`. HTTP errors may
include `status`. Official discovery collapses absent/unhealthy/auth/version/PID
failures into `service_unavailable`; the package does not guess their causes.
