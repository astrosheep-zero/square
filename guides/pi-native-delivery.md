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
Session replacement closes outstanding connections and rebinds the same endpoint
to the new identity; old targets reject.

`observed` / `message_end` means only the matching native extension event was seen.
Pi 1.1.0 emits that event before final append. It is **not durable admission,
final append, model processing, completion or display**. No branch polling or
cross-extension transform compatibility is promised.

Standalone extensions can register `createPiReceiver` from the package's `./pi`
subpath and use `sendPiMessage` directly. Factory registration creates no
resources; start/shutdown own them. Raw SDK `dispose()` callers must explicitly
close the receiver if their host does not emit `session_shutdown`.

Transport frame/key constraints, client
`connectExisting`/`sendText` usage, receipt states, bounds and the exact validated
runtime evidence live in `@astrosheep/agent-delivery` `README.md` and
`VALIDATION.md`. Reproducer:

```sh
npm run build
node --import ./test/sandbox-env.js packages/agent-delivery/test/pi-runtime.mjs /absolute/installed/pi-1.1.0-package-root
```

No real accounts/settings/sessions are used. Terminal keystrokes/rendering, other
Pi builds and platforms are not dynamically validated.
