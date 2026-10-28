# Delivery validation

## Reproducible gates

```sh
# Repository root (tests preload test/sandbox-env.js):
npm ci
npm test
npm run test:cli-process
npm run verify-release
# Standalone package:
cd packages/agent-delivery
npm ci
npm test
```

Package tests isolate HOME/XDG and use the installed official SDK against
loopback fixtures or real local sockets. Packed external consumers verify
exports/type declarations and independent installation. Root release fixtures
verify that Square ships its shared transport leaves without loading the
OpenCode SDK. These prove packaging/transport, not native scheduling.

The format5 integration also tests a real disposable SQLite writer lock delaying
hook presentation settlement beyond the internal deadline: committed presentation
returns its text rather than being abandoned by a timeout race. Shared-lock tests
preserve nonblocking `skipIfBusy` discovery. Both run without real artifacts.

## Recorded live evidence

| Runtime | Observed behavior | Evidence |
| --- | --- | --- |
| Codex 0.160.1, isolated existing Unix app-server, dummy Responses provider | Packed public API: idle steer rejected without starting a turn; busy fenced steer included in request 2; native queue in request 3; explicit-remote CLI queue uses the recipient endpoint despite a different sender CODEX_HOME in request 4; UUID correlation recovered from history | Final packed consumer `/tmp/ad-codex-packed-final-R6L9Af/{probe.mjs,pack.json,live.log}`; captured payloads and checks `/var/folders/xd/ln7zbjqx4xsdgd6n98ln_wb80000gn/T/ad-codex-runtime-5VDlF2/{summary.json,evidence.json}` |
| Codex 0.160.1, packed 0.1.1 unified API, isolated native fixture | Both CLI modes use `connect({ transport: 'cli', boundaries, ... }).queue()`: explicit remote request 4 across sender homes, ordinary CLI without `--remote` request 5; no steer method; SessionEnd plus late Stop rejects further queue known-unsent | Consumer `/tmp/square-format5-release-h22893/consumer/probe.mjs`; pack/live logs `/tmp/square-format5-release-h22893/{agent-pack.json,live.log}`; payloads/checks `/tmp/ad-codex-runtime-27vv3i/{summary.json,evidence.json}` |
| macOS Claude Code 2.1.295, dummy loopback Anthropic provider | Shipped mod: idle/busy Read boundary, held approval, clear/reload/resume, fork and cancellation; extraction repeated idle/busy using shared leaf | `/tmp/claude-inbox-design-validation.md`, `/tmp/claude-native-independent-review.md`, `/tmp/square-claude-final-runtime.log`; extraction `/tmp/claude-extraction-runtime.log`, `/tmp/square-claude-extraction-corner/{idle,busy}` |
| Homebrew OpenCode 2.0.20, private loopback service/provider | Independent raw HTTP/SSE probe (not package): idle steer woke; busy queue/steer admitted before consumption; continuation after read tool included steer, next fresh input included queue | `/tmp/opencode-v2-live-validation.md`, reproducer `/tmp/opencode-v2-live-harness.py`, `/tmp/opencode-v2-live-4xqlwdhc/` |
| OpenCode 2.0.20, actual Square v2 plugin, dummy loopback provider | 21 checks: idle/busy body/context presentation, queue timing, clipped previews, lifecycle, local cancellation and provider failure after admission | `/tmp/square-opencode-live-bm0tr9a2/result.json` |
| Pi 1.1.0, macOS arm64, Node v26.10.0, dummy provider | Fresh packed standalone + Square, one real Square extension: exact idle text, idle queue wake, busy steer/queue placement, directed Square activity, abort/timeout, new-session retirement/stale rejection, endpoint cleanup | `/tmp/pi-shared-final-3h3k4g/`: checks.json (8 checks), log, receipts/session files; 14 actual HTTP model requests |

All live runs used temporary HOME/settings/session/working roots without real
accounts or keys. Existing evidence was not overwritten. Opt-in reproducers:

```sh
# From repository root, installed Claude baseline required:
SQUARE_CLAUDE_LIVE_TEST=1 SQUARE_CLAUDE_LIVE_MODES=idle,busy \
  SQUARE_CLAUDE_LIVE_EVIDENCE=/tmp/your-fresh-evidence \
  node --import ./test/sandbox-env.js --test test/claude-runtime.test.js
# Installed Codex 0.160.1 baseline required; fixture starts its own isolated server:
(cd packages/agent-delivery && npm run build)
AGENT_DELIVERY_CODEX_LIVE_TEST=1 CODEX_BIN=/opt/homebrew/bin/codex \
  node packages/agent-delivery/test/codex-runtime.mjs
# Installed Pi baseline required:
npm run build
node --import ./test/sandbox-env.js packages/agent-delivery/test/pi-runtime.mjs /absolute/pi-1.1.0-package-root
```

## Evidence limits

The audited OpenCode source was `v2.0.20`, commit
`84c9be93a56304a108f1a22df0c5d62c26d5b6ca`. Its default service persisted
transcripts but zero event rows, only `log.synced`; replay is not recovery.
Codex admission is not a read receipt. An external sender did not receive the
owner subscriber's user-message events in the two-client probe; history can
recover correlation but this package implements no read-ack roundtrip. The live
gate invokes the shared hook handler directly, not the installed Square Codex
plugin. Its fixture starts a server; both ordinary CLI and explicit-remote CLI
were exercised against that existing server. Ordinary CLI now allows its normal
auto-start path, but fresh daemon auto-start and private stdio-owner handoff were
not live-validated. Unit/integration tests cover SessionEnd suppressing queue,
including an end during the final currentness gate and a late Stop callback.
Packed consumers also typecheck both Codex capabilities, run CLI queue and end
suppression outside Square, and verify the queue-only shape. CLI receipt ids are
local attempts; only native app-server ids are correlated with server history.
Other Codex versions, WebSocket TCP/TLS/auth deployments and
approval-held execution were not live-tested.
Pi model inclusion was established by captured HTTP payloads, not `message_end`.
Other builds/platforms, terminal rendering/keystrokes and transformed Pi events
were not dynamically validated. Receipt semantics are in [README.md](README.md).

Loopback tests bypass proxies: an inherited proxy once retried a disconnected
POST. End-to-end once-only attempts require intermediaries that do not retry.
