# Catch contention: retrying a blocked commit promptly

A busy SQLite COMMIT retains the write transaction while waiting for readers to leave. Previously it slept 25 ms between attempts, the same as contenders waiting to acquire a transaction. The retained writer also prevents those contenders from progressing.

The change retries COMMIT after 1 ms while retaining the existing 25 ms acquisition backoff. It preserves the transaction, callback result, cancellation and rollback behavior. The shared helper applies to both artifact and host-ledger transactions. No journal mode, receipt semantics, workload, cache or background service changed.

## Measurement

The benchmark now times opening, recognition, first catch, second catch and closing separately. Both baseline and candidate used this instrumentation and the same command:

```sh
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```

Three sequential runs per implementation, each covering both history sizes. Baseline production is `f44f359`; candidate changes only COMMIT retry timing. Baselines ran before candidates, not in randomized order. These local measurements show improvement but are not confidence intervals or a universal latency guarantee.

Values below are the **median of three run-level measurements**. For latency, each measurement is the p95 across 300 workers.

| Metric | Before, 1,800 history | After, 1,800 | Before, 18,000 | After, 18,000 |
| --- | ---: | ---: | ---: | ---: |
| First catch API p95 (ms) | 6,596.63 | 4,619.84 | 7,302.29 | 4,781.38 |
| Second catch API p95 (ms) | 3,620.93 | 2,413.91 | 4,034.01 | 2,613.97 |
| Whole catch phase p95 (ms) | 7,262.52 | 5,464.51 | 8,126.17 | 5,653.63 |
| Aggregate phase CPU (ms) | 23,466.80 | 20,205.76 | 27,313.38 | 21,241.62 |
| Artifact busy observations | 47,578 | 30,824 | 53,418 | 32,265 |
| Artifact COMMIT busy observations | 95 | 138 | 85 | 117 |

First-catch p95 medians fell approximately 30% and 35%; whole-phase medians fell 25% and 30%. Aggregate CPU medians fell 14% and 22%. COMMIT retry counts increased, as expected from polling the retained writer sooner, while total busy observations and CPU medians decreased.

Run-level first-catch p95s, in execution order:

| History | Before (ms) | After (ms) |
| --- | --- | --- |
| 1,800 | 6,119.17 / 6,596.63 / 6,680.30 | 4,619.84 / 4,233.23 / 6,642.77 |
| 18,000 | 7,785.32 / 7,302.29 / 5,966.01 | 4,781.38 / 4,995.59 / 4,694.29 |

The third small-history candidate run was slower than its other two runs and overlapped the baseline range. Its whole-phase p95 was 7,602.57 ms, above all three small-history baseline runs. Contention and machine-load variability remain; this change does not remove multi-second waiting under 300 simultaneous processes.

All twelve scenarios discovered 300 participants, consumed one activity each and consumed none again. All stderr files were empty. First-catch timing covers the full awaited API call, including ownership checks and postcommit identity publication. Whole-phase timing additionally includes open, recognize, the second catch and close; percentiles of individual steps must not be added.

Raw local reports: `/tmp/square-catch-baseline-{1,2,3}.json` and `/tmp/square-catch-commit-{1,2,3}.json`. These measure isolated local storage, not native delivery or ordinary single-user latency.

## Correctness boundaries

Existing SQLite lifecycle tests exercise real blocked COMMITs, single callback execution, event-loop progress, cancellation rollback and cross-process receipt exclusion. Cancellation tests cover precommit rollback and postcommit success. The empty-catch write transaction remains unchanged: avoiding it would require a separate design and measurement, and is not part of this result.
