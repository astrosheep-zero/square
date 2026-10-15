# Indexed host-ledger measurement

The indexed host ledger eliminates whole-file NDJSON reads. This run does not show a consistent reduction in the 300-process catch-phase latency: the smaller-history case was slightly slower and the larger-history case was faster. Artifact contention remains substantial.

## Comparable workload

Baseline: `895ff50` (NDJSON with origin-separated instrumentation). SQLite plus safe retirement candidate: `60ea8b0`. Both used the same benchmark script, 300 processes, session discovery, active bell, disabled filesystem hints, and histories of 1,800 and 18,000 unrelated activities.

```sh
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```

The catch phase times opening the square, recognizing the participant, a first catch, a second catch checking duplicate consumption, and closing the square. These numbers are **not single-catch latency**, nor ordinary single-user latency. Discovery is measured separately. These are one completed run per implementation and history size, not repeated-run confidence intervals.

| Metric | NDJSON, 1,800 | SQLite, 1,800 | NDJSON, 18,000 | SQLite, 18,000 |
| --- | ---: | ---: | ---: | ---: |
| Catch-phase p50 (ms) | 6,134.67 | 6,159.17 | 6,775.98 | 5,532.52 |
| Catch-phase p95 (ms) | 7,307.72 | 7,481.01 | 8,182.00 | 7,170.30 |
| Catch-phase aggregate CPU (ms) | 24,171.34 | 24,045.67 | 27,538.51 | 23,574.19 |
| Artifact busy observations | 46,710 | 52,686 | 56,401 | 46,069 |
| Catch-phase artifact body rows | 300 | 300 | 300 | 300 |
| Catch-phase artifact writes | 600 | 600 | 600 | 600 |
| Discovery p95 (ms) | 1,931 | 1,927 | 1,881 | 1,915 |

Every completed scenario discovered all 300 participants, consumed exactly one activity per participant, and consumed none again on the second catch.

## Ledger work

For either history size, the NDJSON catch phase performed 1,500 file reads totaling 95,520,000 bytes. The SQLite catch phase performed 1,500 data-read executions, returning 1,500 presence rows; all SQL result values together totaled 316,900 bytes (4,500 rows including header results). Host-ledger SQL busy observations were zero.

These are different transport measurements: file bytes versus SQL values returned to JavaScript. They demonstrate that whole-ledger materialization is gone; they do **not** measure equivalent physical disk I/O or prove a proportional speedup. SQLite bypasses the JavaScript filesystem hooks, so zero NDJSON operations/bytes is structural, not a standalone performance result.

The remaining catch-phase contention is attributed to the square artifact, separately from the host ledger. The result motivates investigating concurrent artifact transactions if reducing this latency is the next objective; it does not establish the benefit of any unimplemented change.

## Evidence and limits

Local raw reports: `/tmp/square-indexed-baseline-300.json` and `/tmp/square-indexed-final-300.json`. The completed SQLite run exited zero with empty stderr. An earlier invocation was terminated by the tool's 60-second execution limit before producing a report and was excluded; the completed run used the unchanged workload in a background process.

This benchmark uses an isolated ledger. It does not migrate the live host ledger, exercise real native transports, or measure GC reclamation. GC correctness is covered by the separate retirement, closure-proof, schema-upgrade, and CLI tests. Retirement leaves reusable SQLite pages and indefinitely retained Claude recognition tokens; neither immediate file shrinkage nor bounded total token growth is promised.
