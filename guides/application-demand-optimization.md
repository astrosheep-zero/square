# Application presentation demand

> **Historical evidence, superseded API.** The factory/outcome shapes and split SDK defaults
> below describe the earlier implementation, not current instructions. Use the real
> [Square/Participant API](square-api.md); the independent factory and its design guide are deleted.


## Design

`createSquareApplication(context)` retains complete terminal-facing outcomes. MCP uses `createSquareApplication(context, { presentation: false })`; its outcome has the same `data` contract and `projection: undefined`.

This is one explicit result demand, not a second business implementation. The application still owns admission, retries, receipts, cancellation and delivery. Ordinary early returns and conditional expressions skip presentation work where it was previously performed; there is no deferred projector, registry, cache or resource-lifetime change. CLI projection types remain required, while the data-only factory overload exposes their absence explicitly.

MCP no longer requests join history/perceptions, the pre-expression directed feed, catch presence enrichment, listener context reads, lifecycle event rereads, or history/status/participants presentation-only annotations. Selection/counts required for results and history limits remain. For terminal expressions the directed feed is still captured once **before** landing, not after sending or on each retry. Delivery and postcommit publication remain on the original path.

Two same-operation observations are consolidated:

- Catch resolves caller and all sender filters in one typed-fact read, preserving caller-first validation, canonical error subjects, filter order and known-but-departed senders. The actual selection/receipt transaction, ownership admission and lease fences remain separate and current.
- Expression's known-name check runs inside the existing join preview via an internal `requireKnown` admission option. Unknown names still fail before claiming or mutating; departed participants still reenter once. Ordinary join may still create a name. Preview facts never replace the subsequent ownership/CAS or commit-time checks.

Long-lived MCP connections and concurrent delivery are deliberately outside this change.

## Local MCP measurement

Baseline: `31cc1bf`. Candidate: the presentation-demand and observation changes above. Node v26.10.0. A real MCP client used the SDK's in-memory transport, not a direct call to application helpers. Each call still creates its application and opens/closes the artifact.

Three runs per variant, alternating B1/A1/B2/A2/B3/A3. Each process seeds four participants and 120 2,048-byte historical says outside measurement, joins the probe participant, then runs three warmup cycles and twenty measured cycles of repeated join, express, two empty filtered catches, history and status. Harness session keys are cleared: the probe's `reconnect` label means a repeated no-op join (`kind: joined`), not a real harness ownership reconnect. New measured expressions are small (`probe body`) and use force without pending directed feed; catches are empty. This is not a bulk-payload, ownership-contention or concurrent benchmark. No test suite, build or second benchmark ran alongside the six probes.

Wall times below are the median of three run-level p50s, each from twenty measured calls. Small local timings are illustrative, not a production SLA or the earlier 300-process catch-p95 workload. The stable transaction/statement counts establish removed work more directly.

| MCP operation | Wall p50 before → after (ms) | Artifact read transactions/call | SQL prepares/call |
| --- | ---: | ---: | ---: |
| Repeated no-op join | 1.478 → 1.036 | 3 → 2 | 30 → 15 |
| Express | 3.963 → 3.372 | 6 → 4 | 79 → 61 |
| Empty catch, one sender filter | 3.157 → 1.613 | 5 → 3 | 124 → 40 |
| Empty catch, three sender filters | 3.335 → 1.655 | 7 → 3 | 134 → 42 |
| History | 1.582 → 0.808 | 2 → 2 | 52 → 16 |
| Status | 2.344 → 2.093 | 2 → 2 | 103 → 94 |

Sender lookups still scale with filter count; **transactions do not**. No participant validation has been omitted to obtain that result. Repeated join's body-hydrating row reads fall from ten to zero per call. History still hydrates its ten result rows, and both empty catches hydrate none. Express and status each retain one body-hydrating row in this probe; not all body reads are presentation work.

SQLite counters are attributed by canonical database location. Host-ledger/lock database work is counted separately, never attributed to the artifact. A positive calibration observes one port read as one artifact read transaction and `activities([0,1])` as two hydrated rows. History moves the same hydration counters used for the zero checks. Hydrated bytes in the probe mean returned string/blob bytes, not filesystem I/O.

All six probes passed their calibration, first-join, hydration and no-error controls: 720 measured calls plus six first joins have no recorded errors. Warmup results are not retained or included in that gate. Raw per-call records retain timing/counters/errors but not complete returned payloads; each operation also retains its first measured result summary. Public-data/error parity is established by regression tests, not by those no-error benchmark controls. Recorded compiled-module hashes were checked before and after each probe; the probe script itself was not included in those historical hash manifests. Independent review recomputed the raw timing/counter statistics and confirmed the stated measurement limits.

## Regression evidence

- New tests prove MCP avoids the extra presentation reads, while terminal-facing join/express still hydrate real presentation content and express retains its pre-send feed.
- A body-bearing catch hydrates exactly its selected page; empty catch and archive/status/participants data parity remain intact.
- One versus multiple catch filters has the same read-transaction count; canonical caller/filter errors remain distinct.
- Both new tests fail against the unchanged baseline at the intended hydration/transaction assertions.
- The existing CLI/application/MCP activity/receipt parity, never-joined refusal, departed reentry, metadata ownership, cancellation and postcommit behavior tests pass.
- Full suite: 680 passed, one opt-in Claude runtime test skipped. CLI process suite: 48 passed. Independent static review accepted correctness and control-flow clarity.

Local evidence: `/tmp/square-upper-{before,after}-{1,2,3}.{json,log,exit,sha,integrity}`. Probe: `/tmp/square-mcp-demand-bench.mjs`. Test logs: `/tmp/square-upper-{tests,cli,negative}.log`.
