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
verify that Square ships the shared Claude/Pi leaves without loading the
OpenCode SDK. These prove packaging/transport, not native scheduling.

## Recorded live evidence

| Runtime | Observed behavior | Evidence |
| --- | --- | --- |
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
# Installed Pi baseline required:
npm run build
node --import ./test/sandbox-env.js packages/agent-delivery/test/pi-runtime.mjs /absolute/pi-1.1.0-package-root
```

## Evidence limits

The audited OpenCode source was `v2.0.20`, commit
`84c9be93a56304a108f1a22df0c5d62c26d5b6ca`. Its default service persisted
transcripts but zero event rows, only `log.synced`; replay is not recovery.
Pi model inclusion was established by captured HTTP payloads, not `message_end`.
Other builds/platforms, terminal rendering/keystrokes and transformed Pi events
were not dynamically validated. Receipt semantics are in [README.md](README.md).

Loopback tests bypass proxies: an inherited proxy once retried a disconnected
POST. End-to-end once-only attempts require intermediaries that do not retry.
