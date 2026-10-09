# @astrosheep/agent-delivery

Existing-only plain-text delivery to **OpenCode 2.x**, explicitly addressed
**Claude native inboxes**, and **Pi 1.1.0** sessions. Standalone ESM package,
version 0.1.0; Node `^22.16.0 || >=24.0.0`. No Square dependency, artifact access,
daemon, service startup, or V1 bridge.

| Harness | Coordinate | Delivery | Strongest receipt |
| --- | --- | --- | --- |
| OpenCode | Existing service + persisted session | `steer` (default), `queue` | `accepted`: durable inbox admission only |
| Claude | Explicit session ID + absolute native socket, macOS baseline 2.1.295 | native `next` (default/`steer`); no `queue` or caller `inputId` | `written`: local bytes only, not admission |

| Pi | Explicit session ID + absolute optional extension socket, macOS 1.1.0 | `steer` (default), `queue`; no caller `inputId` | `observed`: correlated `message_end` only |

No receipt proves model processing, human display, or completion. Unknown
attempts are never automatically retried.

The official `@opencode/client` is pinned to **2.0.20**, the audited and tested
baseline. A 2.x health version is necessary, not proof that every earlier/later
2.x service implements this contract: incompatible responses fail closed. There
is no fallback to `/api/status`, V1 `prompt_async`, or another backend.

## Local installation

This package is not published by this contract. To build an installable artifact:

```sh
cd packages/agent-delivery
npm ci
npm test
npm pack
# In a separate consumer directory:
npm install /absolute/path/to/astrosheep-agent-delivery-0.1.0.tgz
```

The tarball includes runnable JavaScript, declarations, README and MIT license;
its only direct runtime dependency is the official SDK. It can be installed and
imported outside this repository, with no Square files. Main API dispatch loads
only the selected harness; `./claude-native` and `./pi` are Node-only leaves with no SDK
imports. Installing the package still installs its OpenCode dependency graph.
The SDK's schema/protocol
packages transitively install `effect@4.0.0-rc.112` (about 51 MiB unpacked in the
observed install), plus its dependencies, even with the Promise entrypoint; this
is not a dependency-free transport. No Solid runtime is installed.

## OpenCode: connect and submit

```js
import { connectExisting, sendText, ConnectionError } from '@astrosheep/agent-delivery'

const target = await connectExisting({
  harness: 'opencode',
  sessionId: 'ses_your_existing_session',
  // registrationFile: '/absolute/custom/state/opencode/service.json',
})

const receipt = await sendText(target, 'Please consider this before the next step.', {
  delivery: 'steer', // default; alternatively 'queue'
  // inputId: 'msg_my_stable_unique_id',
  // timeoutMs: 5000,
  // signal: controller.signal,
})

switch (receipt.state) {
  case 'accepted':
    console.log('Durably admitted:', receipt.inboxId, receipt.delivery)
    break
  case 'unknown':
    console.log('May already be admitted; reconcile before retry:', receipt.inputId, receipt.code)
    break
  case 'rejected':
    console.log('HTTP rejection:', receipt.status)
    break
  case 'unavailable':
    console.log('Known not submitted:', receipt.code)
    break
}
```

Default discovery is **only** `Service.discover({file, version: is2x})`. The SDK
owns registration/PID/version matching and Basic password handling; the default
file is `${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json`. We never call
`ensure`, `stop`, or `opencode api`, and never guess `localhost:4096`.

A session ID does **not** encode its server address. A private standalone service
or remote server requires the explicit official endpoint shape:

```js
const target = await connectExisting({
  harness: 'opencode',
  sessionId: 'ses_your_existing_session',
  endpoint: {
    url: 'http://127.0.0.1:12345',
    auth: { type: 'basic', username: 'opencode', password: process.env.OPENCODE_PASSWORD },
  },
})
```

`auth` is optional. `endpoint` and `registrationFile` are mutually exclusive;
registration paths must be absolute. HTTP(S) URLs may have a base path but not
userinfo, query or fragment; credentials belong in `auth`. Adapter health,
session and prompt requests do not follow redirects. The official managed
discovery probe owns its own fetch behavior and may follow redirects; use an
explicit trusted endpoint if that distinction matters. Connections health-check
native `/api/info`, require a 2.x version,
then validate the session with `session.get`. The resulting frozen in-memory
handle keeps endpoint details private and cannot be serialized or fabricated.
An existing persisted session is sufficient; it does **not** prove an attached
TUI, visibility to a human, or a session's currently running state.

## OpenCode admission semantics

`sendText` calls the public SDK's `session.prompt({sessionID, text, delivery, id,
resume: true})`, once, on `/api/session/:id/prompt`.

- **Steer:** admitted while busy; promoted at a step boundary before a subsequent
  model request. It does not interrupt in-flight tokens or tools.
- **Queue:** waits for the next fresh-input/idle boundary, rather than steering a
  continuation. Both modes wake an idle session by default.
- **Accepted:** a validated native user inbox receipt with the expected session
  and input ID, delivery, payload shape and created time. Only durable admission
  is confirmed, **not model consumption, display, success, or completion**.
- **Unknown:** dispatch began but admission confirmation is missing, timed out,
  was aborted, lost in transport, or malformed. It may already be durable.
  Backend/gateway 5xx and other non-authoritative HTTP failures also remain unknown
  (`transport`); a server may fail after admission.
- **Rejected:** an observed native validation/auth/not-found/conflict response
  (`400`, `401`, `403`, `404`, `409`), even when its error body is unreadable.
  The bounded status and fixed `http_rejection` code are returned.
- **Unavailable:** deadline/abort before dispatch; known not sent. Pre-aborted
  calls do no network work.

Each result contains `harness`, `sessionId`, and `inputId`; accepted adds `inboxId`
and the **returned** delivery. An omitted input ID is generated before dispatch
as `msg_<UUID>`. Caller IDs must have the native `msg_` prefix. Keep the same ID
only when reconciling/retrying the **same logical text**: the native backend uses
first-admission-wins, including already-promoted records, and does not compare
payload equality. Prompt hooks may also transform the admitted text. The package
never retries automatically or claims that unknown means rejected.

There is no watch, cancel, queue-management or completion API here. Native inbox
inspection and careful same-ID reconciliation may be useful, but pending inbox
inspection alone cannot settle already-promoted inputs. Do not assume historical
event replay is available: the tested default 2.0.20 CLI service uses snapshot
`log.sync`, not persisted historical event replay. A future adapter addition is
not an implemented promise.

## Pi: explicit local delivery to a live session

Register the receiver **inside your existing Pi extension** (not a second extension):

```js
import { createPiReceiver, sendPiMessage } from '@astrosheep/agent-delivery/pi'

export default function extension(pi) {
  pi.registerFlag('agent-delivery-socket', { type: 'string', description: 'Explicit private local socket' })
  const receiver = createPiReceiver(pi, {
    get endpoint() { return pi.getFlag('agent-delivery-socket') },
  })
  // Your existing in-process calls may use sendPiMessage(pi, message, nativeOptions).
}
```

The factory opens no resources. The getter is evaluated at `session_start`, after
Pi applies CLI flags. An absent endpoint leaves the receiver inert. It binds the
actual `ctx.sessionManager.getSessionId()`; orderly `session_shutdown` retires all
waits/connections. `close(): Promise<void>` is idempotent. SDK hosts that call raw
`session.dispose()` without emitting shutdown **must explicitly close** the
receiver. Repeated identical starts are idempotent, and replacement sessions can
reuse the endpoint but not an old target. Do not invent/overwrite session env vars.

On **macOS only**, create a private caller-owned parent directory (`0700`) and pass
an absolute Unix socket path (at most 103 UTF-8 bytes; room for a short sibling bind
name is also needed). The socket is `0600`. No parent chmod, TCP, tokens, registry,
discovery, daemon, or stale-file reclamation. Any occupied endpoint fails closed.
The listener binds a temporary sibling socket then atomically publishes its hard
link at the explicit endpoint; cleanup checks the published inode and never deletes
a replacement endpoint. This avoids Node's unconditional unlink of its bind path.

An independent process uses the normal main API:

```js
const target = await connectExisting({
  harness: 'pi', sessionId: 'actual-existing-id', endpoint: '/private/delivery/p.sock',
})
const result = await sendText(target, '/literal text\n  unchanged 🦈', { delivery: 'queue' })
if (result.state === 'observed') console.log(result.evidence) // 'message_end'
```

No trim, text wrapper, command expansion, or arbitrary external custom metadata.
External messages use fixed `customType: 'agent-delivery'`, `display: true`, and
fresh attempt UUID metadata `details.agentDelivery.deliveryId`. `inputId` is a
returned diagnostic coordinate, **not idempotency**; caller `inputId` is unsupported
and rejected before write. Byte-identical concurrent text has independent IDs.
`steer` (default) maps to native `steer`; `queue` to `followUp`; both use
`triggerTurn: true`, waking idle Pi. The stateless `sendPiMessage` preserves the
caller's custom message and native options unchanged and invokes Pi only once.

Pi receipt states:

- **observed**, `evidence: 'message_end'`: receiver saw the matching custom type,
  exact text and attempt metadata in the active session. The extension event is
  **pre-final-append**: this is not finalized append, fsync, durable admission,
  model processing, completion, or human display. Another extension rewriting
  that event is outside this receipt's compatibility promise.
- **unknown**: write/native dispatch may have occurred, but matching observation
  is missing. Abort, deadline, loss, retirement and unobservable async native
  errors do not retract custody. It may still arrive later. No automatic retry.
- **rejected**: explicit pre-injection refusal (`wrong_session`, `invalid_request`,
  `duplicate_inflight_id`). Every send checks session identity again.
- **unavailable**: known stopped before socket write. Preabort sends nothing.

Pi defaults to a 5-second **total client deadline**, including connection and
response; timeout must be finite, positive, and at most **30 seconds**. Receiver
limits: 64 connections, 256 KiB LF-only JSON frame (including escaping), 128 KiB
UTF-8 text, 5 seconds to complete a frame/flush a response, at most 30 seconds
waiting for an event. Split multibyte UTF-8 and U+2028/U+2029 are handled as text,
not framing. Malformed/oversized frames close without injection. Disconnect
retires its waiter. Neither client abort nor receiver cleanup calls `ctx.abort`
or `clearQueue`, and Pi's `void` send return never yields an optimistic receipt.
There is no append tracker, polling, global message cache, durable inbox or replay.

The `./pi` graph is Node-only and loads neither the Pi SDK nor OpenCode SDK. Main
API dispatch imports only the chosen adapter. Package installation still carries
its OpenCode dependency. Square ships this same source graph in its root `dist`
and registers this optional receiver in its **one existing Square Pi extension**;
its two in-process native sends use the same stateless leaf without an IPC hop.
Square retains its own presentation and content-keyed acknowledgment behavior.

## Claude: explicit native inbox

Validated native baseline: **macOS Claude Code 2.1.295**. Other platforms reject
with `ConnectionError('unsupported_platform')`; no Windows authentication or
unvalidated Linux compatibility is promised. The protocol cannot interrogate the
receiver's version, so an endpoint alone does not validate other Claude builds.

```js
import { connectExisting, sendText } from '@astrosheep/agent-delivery'

const target = await connectExisting({
  harness: 'claude',
  sessionId: 'the-receiver-current-session-id',
  endpoint: '/absolute/path/from/receiver/native.sock',
})
const receipt = await sendText(target, 'Plain text for the next native boundary.', {
  delivery: 'steer', // optional; native priority is always next
  // timeoutMs: 5000,
  // signal: controller.signal,
})
```

There is no automatic discovery from a Claude session ID. Obtain the explicit
socket coordinate from the receiving harness. `connectExisting` validates the
identity/path and a present socket; it sends no payload. Filesystem waiting is
bounded and cancellable: an already-issued OS stat can finish later but never
produces a late handle or initiates a send. This check does **not** authenticate
which conversation the receiver owns, prove a live listener, or prove that
native inbound policy will permit your message. The frozen handle keeps its path
private and carries no credentials.

`sendText` defaults to native `priority:'next'`. `steer` is the same next-boundary
delivery, **not interruption** of an in-flight request/tool. `delivery:'queue'`
and any caller `inputId` are unsupported and reject before writing, both in the
per-harness TypeScript overloads and runtime checks. Native `msg_id` is a fresh
UUID per call, not an idempotent reconciliation key. Do not replay an unknown
attempt or reuse an ID automatically.

Claude receipts contain `harness` and `sessionId`:

- `written`: local bytes handed to the socket only. **Not admitted, queued,
  consumed, or accepted**; native refusal/hold can occur without an acknowledgement.
- `unknown`: connected I/O lost, timed out or was aborted; remote custody is uncertain.
- `unavailable`: known not sent, including preabort, expired deadline or unavailable
  endpoint before connection. Fixed `code` values contain no paths, text or raw errors.

There is no accepted state, acknowledgement parser, absence-of-refusal inference,
EOF acceptance, receipt daemon or automatic retry for Claude. A plain native
receiver need not have the Square mod: that mod adds Square-specific lifecycle,
correlation and stored-context presentation confirmation, above this library.
OS-user permissions and native policy remain authoritative. The sender supplies
no child messaging token, `from` identity, plugin tag or claimed authority.

Low-level callers can import the exact transport used by Square:

```js
import { writeClaudeNative } from '@astrosheep/agent-delivery/claude-native'
const result = await writeClaudeNative(
  { sessionId: 'receiver-id', endpoint: '/absolute/native.sock' },
  'plain text',
  { deadline: Date.now() + 5000, signal: controller.signal },
)
// result.outcome: written | unknown | unavailable
```

This Node-only leaf owns framing/socket I/O, not capability discovery or policy;
callers must establish the validated receiver/platform themselves. It validates
finite deadlines within Node's timer range, rejects preabort without a socket
attempt, bounds connect/write, settles once and cleans up. Neither the leaf nor
the package accesses Square participants, artifacts, correlation or evidence.

## Deadlines and errors

All operations default to a **5-second total deadline**. `timeoutMs` must be
finite and positive: Pi accepts at most 30 seconds; OpenCode/Claude at most
`2_147_483_647` (Node's maximum timer delay).
`signal` must be an AbortSignal. A caller deadline bounds waiting, including
response bodies. The SDK discovery probe has its own bounded timeout and cannot
accept our signal: it can finish after callers stop waiting, but we never
continue to session resolution/submission from that late result or launch a
replacement service.

`connectExisting` rejects with exported `ConnectionError`, whose `code` is one of:

| Code | Meaning |
| --- | --- |
| `invalid_arguments` | Invalid harness/session, endpoint/path combination, signal or timeout |
| `aborted`, `timeout` | Caller operation stopped |
| `service_unavailable` | No compatible registered service, unavailable transport, or absent/non-socket Claude endpoint |
| `unsupported_version` | Explicit OpenCode endpoint reports a non-2.x version |
| `unsupported_platform` | Claude or Pi connection outside validated macOS |
| `authentication_failed` | HTTP 401/403 from explicit health/session checks |
| `session_not_found` | HTTP 404 during session lookup |
| `http_rejection` | Other non-200 native HTTP response |
| `invalid_response` | Malformed response or mismatched identity |

An observed HTTP error may also include `status`. Official discovery deliberately
collapses registration absence, health/auth/version/PID failures to absence; these
produce `service_unavailable` rather than guessed specific causes.

`sendText` invalid arguments reject with a fixed-message `TypeError`, before
I/O work. Text must be a nonempty string; a handle must come from this
package instance's `connectExisting`. For valid attempts it resolves one of the
receipt states above. No public errors/results include auth, endpoint URLs,
server bodies, input text, or SDK error causes/stacks. The caller's own session
and input IDs remain in receipts.

## Verification and limits

```sh
npm ci
npm test
```

Tests isolate HOME and all XDG roots themselves, including when invoked directly;
they never discover a user's default service. Tests use the **actual installed
SDK** against authenticated loopback HTTP fixtures and matching temporary native
registrations. They inspect native request/auth/body, version/PID mismatch,
missing sessions/services, authoritative rejection, 5xx after a recorded
submission, malformed acceptance,
pre/post-dispatch abort, ambiguous timeout/loss without retries, concurrent sends,
and late uncancellable discovery. The pack test installs in an external temp
consumer, checks declarations/imports and performs real SDK discovery/send plus
Claude generic/leaf socket writes. A loader forbids OpenCode imports during
Claude consumption. UDS tests capture exact UTF-8 frames, reject unsupported
options, and exercise dead endpoints, bounded filesystem waiting, connected
backpressure timeout/abort and preabort without retries.

These tests demonstrate adapter and package behavior, not live OpenCode execution
or busy/idle promotion. See `VALIDATION.md` in the source package for separately
identified real-runtime evidence and its limits. Native semantics are audited
against official tag `v2.0.20`, commit
`84c9be93a56304a108f1a22df0c5d62c26d5b6ca`; no broader 2.x feature floor is claimed.
