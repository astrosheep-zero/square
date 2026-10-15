# Postcommit simplification: 300-process comparison

Measured on the same local host with Node v26.10.0. Baseline runtime: release 0.3.71 (`90478f8`). Candidate runtime: `03237aa`. The benchmark entrypoint repair in `2bfb68e` was used for both; it replaces imports of removed modules with current artifact/open-square exports, without changing the scenario or deadlines.

```sh
npm run build
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```

The command exercises both 1,800 and 18,000 unrelated historical activities. Each of 300 processes observes one bell, recognizes its participant, performs one consuming catch and one empty repeat. These are synthetic Pi bindings without callable native routes. Counts below aggregate all 300 processes; catch latency describes that entire per-process catch phase, not one standalone API call. MB means decimal bytes. Ledger bytes measure instrumented file reads/writes, not physical disk traffic.

| Measurement | Baseline, 1,800 | Candidate, 1,800 | Baseline, 18,000 | Candidate, 18,000 |
| --- | ---: | ---: | ---: | ---: |
| Ready / complete | 300 / 300 | 300 / 300 | 300 / 300 | 300 / 300 |
| Caught per process | 1 | 1 | 1 | 1 |
| Reconsumed total | 0 | 0 | 0 | 0 |
| Catch ledger MB | 229.248 | 95.520 | 229.248 | 95.520 |
| Catch ledger operations | 4,200 | 1,500 | 4,200 | 1,500 |
| Catch p50 seconds | 18.65 | 5.80 | 22.76 | 5.36 |
| Catch p95 seconds | 22.57 | 7.11 | 26.62 | 6.85 |
| Catch SQLite busy errors/retries | 174,082 | 45,555 | 221,701 | 45,028 |
| Catch CPU seconds, aggregate | 65.01 | 23.31 | 73.50 | 21.65 |
| Discovery p95 seconds | 1.870 | 1.877 | 1.877 | 1.897 |
| Five-second idle CPU seconds, aggregate | 3.181 | 3.241 | 3.594 | 3.088 |

These historical SQL/busy counts combined artifact SQL with host-ledger file-lock SQL; “busy errors/retries” counted thrown busy errors, not independently observed retries. They cannot be compared directly with the origin-separated counters now in the benchmark. Rerun both runtimes with the same new script. Its `ledgerSql` reports host-root SQL (including lock databases), separately from artifact SQL. Returned SQL string/blob bytes are not physical I/O or full JSON decode measurements; SQLite's zero instrumented filesystem bytes is a transport change, not a performance gain.

Idle body hydration and ledger bytes remained zero. Each discovery and catch phase hydrated 300 activity bodies. The original 20-second discovery deadline and derived phase guard were unchanged.

The candidate removes a discarded catch-completion sweep and combines postcommit identity publication around one fresh presence observation. Admission remains a separate ownership check. Source changes also consolidate duplicate native connection-option declarations; those type changes do not account for the performance result. Production TypeScript across the three changes is net -57 lines without formatting compression. The benchmark repair is separately net -1 tooling line.

Ledger bytes fell 58.3%, and ledger operation count fell 64.3%. The observed latency improvement is a single before/after local comparison, not an SLA or an isolated causal attribution: other agent work and verification occurred during the broader run, and host load was not controlled. The deterministic operation reduction supports the intended deletion of duplicate work. Idle discovery was not redesigned, and this does not measure callable-route publication or long-lived leased catch optimization.

Each change passed independent review and its declared verification before integration. Root CLI process checks passed all 48 cases; the native adapter package passed 42 cases with its existing Windows-only skip. Full root verification retained its existing skipped case.

Local raw reports: `/tmp/square-round2-baseline-300.json` and `/tmp/square-round2-final-300.json`. These temporary reports are diagnostic artifacts, not repository dependencies. No ledger storage migration or evidence GC change is included.
