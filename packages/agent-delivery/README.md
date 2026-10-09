# @astrosheep/agent-delivery

Existing-only plain-text delivery to **OpenCode 2.x**, explicitly addressed
**Claude native inboxes**, and **Pi 1.1.0** sessions. Standalone ESM, version
0.1.0; Node `^22.16.0 || >=24.0.0`. No Square dependency, service startup,
daemon, V1 bridge, or automatic retry.

| Harness | Coordinate | Delivery | Strongest receipt |
| --- | --- | --- | --- |
| OpenCode | Existing service + persisted session | `steer` (default), `queue` | `accepted`: durable inbox admission |
| Claude | Explicit session ID + absolute native socket | `steer`/native `next`; no `queue` or caller `inputId` | `written`: local bytes only |
| Pi | Explicit session ID + optional extension socket | `steer` (default), `queue`; no caller `inputId` | `observed`: correlated `message_end` |

No receipt proves model processing, human display, or completion. An unknown
attempt may still arrive; reconcile before any retry. Validated baselines and
reproducers are in [VALIDATION.md](VALIDATION.md).

## Installation and API

Not published by this contract. Build and install a local tarball:

```sh
cd packages/agent-delivery
npm ci
npm test
npm pack
# In a separate consumer directory:
npm install /absolute/path/to/astrosheep-agent-delivery-0.1.0.tgz
```

The tarball includes JavaScript, declarations, docs and MIT license. Its sole
runtime dependency is official `@opencode/client@2.0.20`; upstream dependencies
include Effect (~51 MiB unpacked in the validated install), not Solid. The main
API loads only the selected adapter. `./claude-native` and `./pi` are Node-only
leaves; installing the package still installs the OpenCode dependency graph.

```js
import { connectExisting, sendText, ConnectionError } from '@astrosheep/agent-delivery'

const target = await connectExisting({ harness: 'opencode', sessionId: 'ses_existing' })
const receipt = await sendText(target, 'Exact plain text', {
  delivery: 'steer', // default; queue where supported
  // timeoutMs: 5000, signal: controller.signal,
  // inputId: 'msg_stable_id', // OpenCode only
})
```

Handles are frozen, private in-memory coordinates from this package instance,
not serializable or fabricable. Text must be a nonempty string. Invalid send
arguments reject with a fixed-message `TypeError` before I/O. Results expose no
endpoints, credentials, text, server bodies or raw SDK errors; caller session
and input IDs remain diagnostic coordinates.

## OpenCode

Default discovery is only `Service.discover({file, version: is2x})`, using
`${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json`. The SDK owns
registration/PID/version matching and Basic auth. Override with an absolute
`registrationFile`, or an explicit endpoint for private/remote services:

```js
const target = await connectExisting({
  harness: 'opencode', sessionId: 'ses_existing',
  endpoint: {
    url: 'http://127.0.0.1:12345',
    auth: { type: 'basic', username: 'opencode', password: process.env.OPENCODE_PASSWORD },
  },
})
```

`auth` is optional; endpoint and registration file are mutually exclusive.
HTTP(S) base paths are allowed, userinfo/query/fragment are not. Adapter requests
do not follow redirects; the SDK discovery probe owns its fetch behavior and
may follow them. A session ID does not encode a server address. No `ensure`,
`stop`, `opencode api`, guessed port or replacement service is used.

Connect checks native `/api/info` for 2.x and resolves `session.get`. A persisted
session is sufficient, not proof of an attached TUI or running agent. The pinned
SDK/baseline is 2.0.20, not a compatibility guarantee for every 2.x service.

Send calls `session.prompt({sessionID, text, delivery, id, resume: true})` once.
Steer is promoted at a step boundary, without interrupting in-flight work; queue
waits for a fresh-input/idle boundary. Both wake idle sessions.

- **accepted**: validated native inbox receipt matching session, input ID,
  delivery, payload shape and created time; includes `inboxId` and returned
  delivery. Admission only; prompt hooks may transform the text.
- **unknown**: dispatch began without authoritative confirmation, including
  abort/timeout/loss/malformed success or gateway/server failure. A 5xx can
  follow durable admission.
- **rejected**: native HTTP `400`, `401`, `403`, `404`, `409`, even with an
  unreadable body; bounded `status` and `http_rejection` code.
- **unavailable**: known stopped before dispatch.

Every receipt has `harness`, `sessionId`, `inputId`. An omitted ID becomes
`msg_<UUID>`; caller IDs require `msg_`. Native first-admission-wins includes
already-promoted records and does not compare text: reuse an ID only for the
same logical input. Pending-inbox inspection cannot settle promoted inputs.
There is no watch, replay, queue-management, cancellation or completion API;
the tested default service does not persist historical event replay.

## Claude native inbox

Validated on macOS Claude Code 2.1.295. The protocol cannot interrogate version;
callers must establish the receiver baseline. Other platforms are unsupported.

```js
const target = await connectExisting({
  harness: 'claude', sessionId: 'receiver-current-session-id',
  endpoint: '/absolute/path/from/receiver/native.sock',
})
const receipt = await sendText(target, 'Plain text for the next boundary.')
```

The explicit path must currently be a socket. Connect sends nothing and proves
neither listener liveness, conversation ownership nor native policy approval.
No session-ID discovery, credentials, child token, claimed sender or authority.
OS-user permissions and native inbound policy remain authoritative.

Send writes session-targeted tokenless UTF-8 NDJSON `msgV:1`, `priority:'next'`,
with a fresh UUID per call. Steer means the next boundary, not interruption.
Queue and caller input IDs reject before write.

- **written**: local bytes handed to socket, not admission; native hold/refusal
  can occur without acknowledgment.
- **unknown**: connected I/O lost, aborted or timed out; custody uncertain.
- **unavailable**: known not sent before connection, including absent endpoint.

Receipts contain `harness`, `sessionId` and fixed diagnostic codes, no input ID.
There is no acknowledgment parser or inference from EOF/absence of refusal.
A plain peer needs no Square mod; Square adds lifecycle/correlation and
stored-context presentation evidence above this transport.

Low-level callers use the same Node-only leaf as Square:

```js
import { writeClaudeNative } from '@astrosheep/agent-delivery/claude-native'
const result = await writeClaudeNative(
  { sessionId: 'receiver-id', endpoint: '/absolute/native.sock' },
  'plain text', { deadline: Date.now() + 5000, signal: controller.signal },
) // result.outcome: written | unknown | unavailable
```

The leaf owns framing/bounded socket I/O only, settles once and cleans up;
callers establish platform/capability. It knows no Square artifacts or evidence.

## Pi extension socket

Register **inside an existing extension**, not a second delivery extension:

```js
import { createPiReceiver, sendPiMessage } from '@astrosheep/agent-delivery/pi'
export default function extension(pi) {
  pi.registerFlag('agent-delivery-socket', { type: 'string', description: 'Private local socket' })
  const receiver = createPiReceiver(pi, {
    get endpoint() { return pi.getFlag('agent-delivery-socket') },
  })
  // Existing in-process sends use sendPiMessage(pi, message, nativeOptions).
}
```

Factory registration opens nothing. At `session_start`, the lazy getter reads
CLI flags and binds actual `ctx.sessionManager.getSessionId()`; absent endpoint
is inert. Identical starts are idempotent. Replacement retires outstanding
connections and old targets. Shutdown closes resources; raw SDK `dispose()`
callers must explicitly await the receiver's idempotent `close()` if their host
omits `session_shutdown`. Never invent/overwrite session environment identity.

macOS only: explicit absolute Unix socket (at most 103 UTF-8 bytes, with room
for a short sibling name), private caller-owned `0700` parent, `0600` socket.
No parent chmod, stale-file reclamation, discovery, registry, tokens or TCP.
Occupied paths fail closed. Temporary sibling bind + atomic hard-link publish
avoids Node's unconditional bind-path unlink; cleanup checks published inode.

```js
const target = await connectExisting({
  harness: 'pi', sessionId: 'actual-existing-id', endpoint: '/private/delivery/p.sock',
})
const receipt = await sendText(target, '/literal text\n  unchanged 🦈', { delivery: 'queue' })
```

No trim, command expansion or external custom metadata. Messages have fixed
`customType:'agent-delivery'`, `display:true`, fresh UUID metadata
`details.agentDelivery.deliveryId`. Returned `inputId` is not idempotency;
caller IDs reject before write. Steer maps to native steer, queue to followUp,
both `triggerTurn:true`. `sendPiMessage` preserves in-process message/options
and invokes native Pi once.

- **observed**, `evidence:'message_end'`: active-session event matched exact
  type/text/attempt metadata. Pi 1.1.0 emits it **before final append**: not
  durable admission, final append or compatibility with another extension
  rewriting the event.
- **unknown**: dispatch/write may have occurred but observation is missing.
  Abort/loss/retirement do not retract custody; async native errors may be unobservable.
- **rejected**: pre-injection `wrong_session`, `invalid_request` or
  `duplicate_inflight_id`; every send rechecks identity.
- **unavailable**: known stopped before write.

Receiver bounds: 64 connections, 256 KiB LF JSON frames, 128 KiB UTF-8 text,
5 seconds for partial frame/response flush, at most 30 seconds for correlation.
Malformed/oversized frames close without injection; disconnect retires waiters.
Neither cleanup nor client abort calls native abort/clearQueue. No polling,
append tracker, global cache, durable inbox or replay. Square ships this same
source in its existing extension; audience/presentation/cancel policy stays in
Square. The leaf imports neither harness SDK.

## Deadlines and connection errors

Default **5-second total deadline**, including body/response waiting.
`timeoutMs` must be finite and positive: Pi max 30 seconds, OpenCode/Claude max
`2_147_483_647` (Node timer range). `signal` must be an AbortSignal. Preabort
sends nothing. SDK discovery has its own bounded wait and may finish late, but
late results never continue into session lookup/send or service startup.

`connectExisting` throws exported `ConnectionError` with fixed `code`:

| Code | Meaning |
| --- | --- |
| `invalid_arguments` | Invalid coordinate/options |
| `aborted`, `timeout` | Caller stopped waiting |
| `service_unavailable` | Discovery absence, transport failure or absent/non-socket endpoint |
| `unsupported_version`, `unsupported_platform` | Outside supported native contract/platform |
| `authentication_failed`, `session_not_found` | Explicit checks returned 401/403 or session 404 |
| `http_rejection`, `invalid_response` | Other non-200 or malformed/mismatched response |

HTTP errors may include `status`. Official discovery collapses absence and
health/auth/version/PID failures to `service_unavailable`, not guessed causes.
Package tests isolate HOME/XDG, use installed SDK/loopback sockets and fresh
packed external consumers; real-runtime evidence is separately identified in
[VALIDATION.md](VALIDATION.md), not inferred from fixtures.
