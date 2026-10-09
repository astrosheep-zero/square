# @astrosheep/agent-delivery

Existing-only text admission to **OpenCode 2.x** sessions. Standalone ESM package,
version 0.1.0; Node `^22.16.0 || >=24.0.0`. No Square dependency, artifact access,
plugin, daemon, service startup, V1 bridge, or Claude adapter.

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
imported outside this repository, with no Square files. The SDK's schema/protocol
packages transitively install `effect@4.0.0-rc.112` (about 51 MiB unpacked in the
observed install), plus its dependencies, even with the Promise entrypoint; this
is not a dependency-free transport. No Solid runtime is installed.

## Connect and submit

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

## Admission semantics

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

## Deadlines and errors

Both operations default to a **5-second total deadline**. `timeoutMs` must be
finite, positive and at most `2_147_483_647` (Node's maximum timer delay).
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
| `service_unavailable` | No compatible registered service, or unavailable transport |
| `unsupported_version` | Explicit endpoint reports a non-2.x version |
| `authentication_failed` | HTTP 401/403 from explicit health/session checks |
| `session_not_found` | HTTP 404 during session lookup |
| `http_rejection` | Other non-200 native HTTP response |
| `invalid_response` | Malformed health/session response or mismatched session identity |

An observed HTTP error may also include `status`. Official discovery deliberately
collapses registration absence, health/auth/version/PID failures to absence; these
produce `service_unavailable` rather than guessed specific causes.

`sendText` invalid arguments reject with a fixed-message `TypeError`, before
network work. Text must be a nonempty string; a handle must come from this
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
consumer, checks declarations/imports and performs real SDK discovery/send.

These tests demonstrate adapter and package behavior, not live OpenCode execution
or busy/idle promotion. See `VALIDATION.md` in the source package for separately
identified real-runtime evidence and its limits. Native semantics are audited
against official tag `v2.0.20`, commit
`84c9be93a56304a108f1a22df0c5d62c26d5b6ca`; no broader 2.x feature floor is claimed.
