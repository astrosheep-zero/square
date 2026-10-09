# Delivery validation

## Shared Claude native extraction

The same `src/claude-native.ts` owns tokenless NDJSON framing and bounded socket
I/O for both this package and Square's root coordinator. Square's compiled root
imports its emitted `dist/packages/agent-delivery/src/claude-native.js`; it does
not import this package's generic API, Claude handle adapter, or OpenCode SDK.
The root duplicate is removed.

Standalone tests use real local UDS sockets to capture UTF-8 frames and fresh
UUIDs, show known-unsent preabort/deadline/dead-endpoint results, and force
connected backpressure for unknown timeout/abort. These are transport fixtures,
not live Claude scheduling. Connection tests prove bounded/cancellable caller
waiting for filesystem validation with no late continuation. Unsupported queue
and input IDs reject before writing.

The fresh external packed consumer imports the main API and `./claude-native`,
typechecks per-harness options, writes through both paths on macOS, and installs
no Square dependency. A module loader rejects OpenCode SDK resolution during
Claude use, proving the actual imports do not initialize it.

The accepted migration separately proved idle, busy Read boundary, held approval,
clear/reload/resume, fork and terminal cancellation on installed macOS Claude Code
2.1.295 using a dummy-key loopback Anthropic provider. Accepted commit:
`c6e4eed65f864c64cb853f2b9d999da63d67feac`; protocol/report artifacts:
`/tmp/claude-inbox-design-validation.md`, `/tmp/claude-native-independent-review.md`,
`/tmp/square-claude-final-runtime.log`. Extraction repeats idle/busy using the
repository's opt-in shipped-plugin fixture with a new private evidence root;
no account, user settings or session is accessed. Extraction rerun passed:

```sh
SQUARE_CLAUDE_LIVE_TEST=1 SQUARE_CLAUDE_LIVE_MODES=idle,busy \
  SQUARE_CLAUDE_LIVE_EVIDENCE=/tmp/square-claude-extraction-corner \
  node --import ./test/sandbox-env.js --test test/claude-runtime.test.js
```

Both modes captured the audience-correct notification body in actual local model
requests and Square presentation evidence; busy also captured the Read tool
result at the next boundary. Output: `/tmp/claude-extraction-runtime.log`;
private copied fixture and API/bridge/evidence records:
`/tmp/square-claude-extraction-corner/{idle,busy}`. No original fixture evidence
was overwritten. Original accepted plugin bytes remain unchanged.

Root release tests also pack/extract Square into a separate temporary consumer,
verify its coordinator's shared import and shipped mod, and send through the
packed leaf over a real UDS. Root build emits only the imported Claude transport,
not the generic/Claude handle adapter or OpenCode graph. Socket written remains
weaker than native admission; only Square's receiver append evidence confirms
stored presentation.

## OpenCode 2.0.20 (preserved prerequisite evidence)

## Package and actual SDK fixtures

`npm ci && npm test` builds strict TypeScript and runs authenticated loopback
fixtures using the **installed official `@opencode/client@2.0.20`**. No SDK mock,
V1 endpoint, Square import, or artifact access is used. Fixture registrations
exercise native PID/version/auth matching and existing-only discovery.

The package test packs the package, installs the tarball in a fresh temporary
consumer outside Square, typechecks the documented exports, imports the installed
package and runs default discovery + queue send. It checks the request, auth,
receipt, tarball contents and absence of a Square dependency. Temporary HOME/XDG
roots and loopback proxy bypass are set by tests themselves.

The installed graph includes `@opencode/protocol@2.0.20`,
`@opencode/schema@2.0.20` and **`effect@4.0.0-rc.112`** through upstream peers.
Observed local unpacked sizes: client ~1.2 MiB, protocol ~2.3 MiB, schema ~4.4 MiB,
Effect ~51 MiB; Effect also brings fast-check and msgpackr (with optional native
extraction packages). Solid is an unmet *optional* SDK peer and is not installed.
The Promise client works with this actual npm dependency graph; no claim of a
tiny/dependency-free install or unsupported peer stripping is made.

Failure evidence includes no network for preabort/invalid arguments, ambiguous
post-dispatch abort/timeout/transport loss, invalid success receipts, HTTP 409
with an unreadable error body, and HTTP 503 **after the fixture records the
submission**. Unknown attempts preserve their input ID and have exactly one
adapter submission, never an automatic retry. Late SDK discovery does not
continue to session lookup or prompt. Environment proxies are deliberately
bypassed for local fixtures: an initial test observed the user's configured proxy
retry a disconnected POST, a behavior outside the SDK/adapter. Consumers must
also avoid retrying intermediaries if they need end-to-end once-only attempts.

## Separate real installed-runtime experiment

A separately owned investigator (`aku/elite/f4126c0b`) ran the **actual installed
Homebrew OpenCode 2.0.20 executable**, not this package or its SDK fixture. Report:
`/tmp/opencode-v2-live-validation.md`; reproducer:
`/tmp/opencode-v2-live-harness.py`; successful evidence root:
`/tmp/opencode-v2-live-4xqlwdhc/` (`result.json`, `model-requests.json`,
`live-events.json`, snapshot inbox/history observations and server logs).

Its own private loopback `opencode serve --hostname 127.0.0.1 --port 0` ran with
fresh allowlisted HOME/XDG/TMP/config roots, no inherited keys/auth/proxy, and an
explicit OpenAI-compatible **local dummy provider**. Only temporary sessions and
a temporary `probe.txt` read tool were used. No user service, live user session,
real provider account, global configuration or managed-service lifecycle was
accessed. Its owned server and fixture were stopped/reaped in `finally`.

Observed independently through raw HTTP, live SSE, inbox snapshots and actual
local model-request bodies:

1. Idle steer admission woke the session and reached the local provider.
2. While an initial model request was held, queue-first then steer-second both
   returned native inbox admission, before either input was consumed.
3. After a safe read tool, the continuation model request included steer but not
   queue; the pending inbox retained only queue.
4. After terminal continuation, the next fresh-input model request included
   queue. Execution succeeded.

This is live validation of the **native 2.0.20 behavior**, while package/SDK
behavior is validated by separate loopback tests. It is not a live test of the
new adapter, managed discovery, an attached TUI, every provider, or every 2.x
version. Pinned TUI source uses the same client/HTTP handler; that code-path
equivalence does not prove dynamic display in a TUI.

Important correction from the experiment: the default CLI service persisted
sessions/transcript but **zero event rows**. Historical log requests returned
only `log.synced`; event persistence is disabled by default in this version's
CLI wiring. Live SSE established per-input promotion during the experiment;
**historical event replay/reconnection is not a default recovery guarantee**.
The package promises only validated inbox admission and implements no watch or
replay API.

## Acceptance limits

- Verified SDK/runtime baseline is exact 2.0.20, official source commit
  `84c9be93a56304a108f1a22df0c5d62c26d5b6ca`.
- No earliest compatible 2.x feature floor is established. Other 2.x services
  must implement the same native health/session/prompt contract or fail closed.
- Acceptance is not model consumption, completion or human/TUI display.
- The original OpenCode phase included no automatic retry, cancellation, queue
  management, history recovery, service startup/replacement/stop, V1 support or
  Claude implementation, and left root Square source/scripts/dependencies/config
  unchanged. The subsequent Claude extraction described above does not change
  OpenCode's validated semantics or SDK baseline.
