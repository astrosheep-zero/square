# Pi shared native delivery

The shipped `extensions/square-pi.js` remains the **only Square Pi extension**.
Both its activity steer and advisory `nextTurn` send call the SDK-free shared
`sendPiMessage` leaf compiled from `packages/agent-delivery/src`. Square keeps
framing, custom type, display, preview/UI, observation/presentation evidence,
retry/drop and canceled-batch suppression; the leaf neither schedules nor tracks.

For independent existing-session delivery, opt into its local receiver:

```sh
mkdir -m 700 /private/path/delivery
pi --agent-delivery-socket /private/path/delivery/p.sock
```

The parent must already be private and caller-owned. Explicit macOS Unix endpoint
only; no discovery, registry, daemon or second extension. The flag is read lazily
at session start. Missing flag creates no socket. Occupied paths fail closed.

A separately installed `@astrosheep/agent-delivery` consumer uses:

```js
import { connectExisting, sendText } from '@astrosheep/agent-delivery'
const target = await connectExisting({
  harness: 'pi', sessionId: 'actual-live-session-id', endpoint: '/private/path/delivery/p.sock',
})
const receipt = await sendText(target, 'exact plain text', { delivery: 'steer' })
```

The actual native identity and explicit endpoint must both match. Session
replacement closes outstanding connections and rebinds the same configured
endpoint to the new identity; old targets reject. `queue` means native `followUp`,
not an invented package queue. Both modes wake idle Pi. Input is literal and
caller input IDs are unsupported: fresh per-attempt metadata is never body text.

`observed` / `message_end` means only the matching native extension event was seen.
Pi 1.1.0 emits that event before final append. It is **not durable admission,
final append, model processing, completion or display**. No branch polling or
cross-extension transform compatibility is promised. Unknown timeout/abort/loss
may still arrive later; neither this receiver nor its client stops a user's run,
clears native queues, or retries automatically.

Bounds: 5-second default client total deadline, configurable up to 30 seconds;
64 live connections, 256 KiB LF JSON framing, 128 KiB UTF-8 text; 5 seconds for a
partial frame or response flush, at most 30 seconds for correlation. Socket mode
0600; temporary sibling bind + atomic hard-link publish prevents occupied-path
reclamation and cleanup checks the published inode. No broad parent chmod.

Standalone extensions can register `createPiReceiver` from the package's `./pi`
subpath and use `sendPiMessage` directly. Factory registration creates no resources;
start/shutdown own them. Raw SDK `dispose()` callers must explicitly close the
receiver if their host does not emit `session_shutdown`.

Validation: actual installed **Pi 1.1.0, macOS arm64, Node v26.10.0**, one extension,
fresh packed standalone and Square installations, isolated HOME/XDG/session roots
and a loopback dummy provider. Reproducer:

```sh
npm run build
node --import ./test/sandbox-env.js packages/agent-delivery/test/pi-runtime.mjs /absolute/installed/pi-1.1.0-package-root
```

No real accounts/settings/sessions are used. See package `VALIDATION.md` for the
recorded evidence and scope. Terminal keystrokes/rendering, other Pi builds and
platforms are not dynamically validated.
