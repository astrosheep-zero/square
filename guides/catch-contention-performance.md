# Catch contention: commit retries, empty reads, and shorter writes

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

Existing SQLite lifecycle tests exercise real blocked COMMITs, single callback execution, event-loop progress, cancellation rollback and cross-process receipt exclusion. Cancellation tests cover precommit rollback and postcommit success. The COMMIT-only measurements above retain the empty-catch write transaction. The subsequent optimization below measures its removal separately.

## Follow-up: empty catches and repeated observation work

Ordinary non-ID, non-leased catches now inspect pending indexes in a read transaction. An empty page returns its complete observation from that snapshot without acquiring the artifact writer or hydrating bodies. A nonempty page is selected again inside the existing receipt transaction; the probe never decides which activities get consumed. Exact-ID and leased catches keep their existing write path. Ownership checks and identity publication remain in place.

Catch observations now reuse one roster and header for standing count and terminal status. Schema validation precomputes only the expected SQL constant; actual schema, identity, version, journal mode, and header checks still run inside each transaction. These three changes were measured together, so the results do not isolate each change's contribution.

The same benchmark command ran three times on baseline `03623cf`, then three times on the candidate, covering both histories each time. These are fresh baselines, separate from the earlier COMMIT experiment. No workload ran alongside the benchmarks. As above, ordering was sequential, not randomized, and results describe this local 300-process workload.

| Metric | Before, 1,800 history | After, 1,800 | Before, 18,000 | After, 18,000 |
| --- | ---: | ---: | ---: | ---: |
| First catch API p95 (ms) | 5,681.03 | 3,729.06 | 4,967.29 | 3,654.90 |
| Second, empty catch API p95 (ms) | 2,868.83 | 79.80 | 2,608.11 | 55.08 |
| Whole catch phase p95 (ms) | 6,315.96 | 4,111.88 | 5,701.10 | 3,887.74 |
| Aggregate phase CPU (ms) | 22,441.95 | 17,401.83 | 21,456.88 | 16,184.47 |
| Artifact busy observations | 34,542 | 18,780 | 32,986 | 18,638 |
| Artifact COMMIT busy observations | 137 | 323 | 148 | 287 |

Each cell is the median of three run-level measurements. Empty-catch p95 medians fell 97% and 98%; first-catch medians fell 34% and 26%; whole-phase medians fell 35% and 32%; CPU medians fell 22% and 25%. Total busy observations fell, while COMMIT busy observations increased. The extra read probe changes contention; fewer writer acquisitions do not imply every busy counter falls.

Run-level p95s in execution order:

| History | Call | Before (ms) | After (ms) |
| --- | --- | --- | --- |
| 1,800 | First | 7,655.42 / 4,857.49 / 5,681.03 | 4,274.17 / 3,729.06 / 3,557.04 |
| 18,000 | First | 4,967.29 / 5,029.40 / 4,895.89 | 5,005.24 / 3,356.44 / 3,654.90 |
| 1,800 | Empty | 4,495.46 / 2,348.03 / 2,868.83 | 56.35 / 79.80 / 82.83 |
| 18,000 | Empty | 3,139.28 / 2,506.64 / 2,608.11 | 53.31 / 55.08 / 56.97 |

The first large-history candidate's consuming catch overlaps the baseline range. Consuming catches still wait seconds under this load; this is not a guarantee of millisecond catch latency generally. The second catch measures an empty result immediately after consumption, not a long-running idle lease.

All twelve scenarios discovered 300 participants, consumed exactly one activity per worker, and consumed none again: 3,600 successful worker results. Each scenario hydrated 300 bodies and issued 600 artifact SQL writes. Empty baseline transactions already wrote no rows; the improvement removes writer acquisition, not receipt writes. Successful artifact transactions per scenario increase from 1,800 to 2,100 because nonempty catches add a read probe. All stderr files were empty.

Focused tests exercise empty snapshot completeness, absence of writer acquisition/body hydration/receipts, a competing consumer between probe and write selection, exact-ID repetition, lease fencing, validation, cancellation, and ownership publication. The existing performance assertion now checks that an empty catch makes no hydration request.

Raw local reports: `/tmp/square-catch-empty-before-{1,2,3}.json` and `/tmp/square-catch-empty-after-{1,2,3}.json`. The final cap-first short circuit in `watchTerminalStatus()` restores its earlier read behavior; it is used by lease pulses and lies outside this benchmark's non-idle path.

## Follow-up: shortening consuming transactions

The next candidate adds transaction-local participant counts instead of decoding the whole roster for catch/terminal summaries. Latest-say ordinals use the existing participant lifetime count when the selected activity is that actor's latest say; older activities retain the indexed prefix count. Artifact acquisition also passes its already-validated header to the transaction callback instead of reading and decoding it again. Schema validation still occurs inside every transaction. There is no persistent schema change or cross-transaction cache.

The benchmark now measures explicit transaction boundaries per connection and separates artifact from host-ledger connections:

- Acquisition: first BEGIN attempt to successful BEGIN return, including retry gaps.
- Hold: successful BEGIN return to first COMMIT attempt, including validation, decoding and off-CPU wall time.
- Commit: first COMMIT attempt to successful COMMIT return, including retries.

Only committed transactions contribute timing samples. Rollback resets the sample; unsuccessful read acquisition/validation retries are visible in counts but do not become committed timings. `BEGIN DEFERRED` returning does not imply a read lock has already been acquired. Concurrent read durations cannot be summed into a serial lock-occupancy number. Batched transaction controls without observable inner boundaries are counted separately and excluded from exact timings. Artifact SQL execution durations exclude preparation and JavaScript decoding. Bounded self-tests exercise busy BEGIN, busy COMMIT, rollback/reset and origin separation.

Fresh baseline `13d1a36` and candidate each ran three times with the same new instrumentation and the command above, both histories per run. Baselines ran first; no test suite or second benchmark ran alongside the measurements. These changes were measured together, not as independent experiments.

| Metric | Before, 1,800 history | After, 1,800 | Before, 18,000 | After, 18,000 |
| --- | ---: | ---: | ---: | ---: |
| First catch API p95 (ms) | 3,528.76 | 2,678.86 | 3,685.07 | 2,865.71 |
| Empty catch API p95 (ms) | 68.23 | 89.97 | 58.31 | 91.11 |
| Whole catch phase p95 (ms) | 3,831.22 | 2,998.22 | 4,165.47 | 3,177.27 |
| Write acquisition p95 (ms) | 2,739.46 | 1,950.57 | 2,961.04 | 2,257.01 |
| Write hold p95 (ms) | 8.33 | 5.32 | 10.05 | 5.88 |
| Write commit p95 (ms) | 4.15 | 3.81 | 4.36 | 4.24 |
| Aggregate phase CPU (ms) | 16,348.86 | 13,014.67 | 17,732.24 | 13,499.75 |
| Artifact busy observations | 16,201 | 13,081 | 20,023 | 12,508 |

Cells are medians of three run-level measurements. Each scenario has 300 successful consuming write transactions, so write percentiles span those 300 transactions. First-catch p95 medians fall 24% and 22%; whole-phase medians fall 22% and 24%; CPU falls 20% and 24%. Write acquisition falls 29% and 24%, and hold p95 falls 36% and 42%. Percentiles of these stages must not be added to reconstruct the API percentile.

Empty-catch p95 regresses by 22 ms and 33 ms (32% and 56%) in this contended workload. The faster consuming path does not improve every operation. The current measurements do not isolate the cause of this regression; empty catches still use a read transaction, and the 25 ms acquisition retry interval is unchanged. The consuming-call improvement outweighs it in whole-phase time, but the regression remains part of the result.

| History | Call | Before p95 runs (ms) | After p95 runs (ms) |
| --- | --- | --- | --- |
| 1,800 | First | 3,572.79 / 3,123.90 / 3,528.76 | 2,361.69 / 2,732.76 / 2,678.86 |
| 18,000 | First | 3,577.88 / 3,685.07 / 4,165.72 | 2,865.71 / 2,975.57 / 2,813.31 |
| 1,800 | Empty | 68.23 / 85.81 / 61.32 | 100.68 / 89.97 / 87.47 |
| 18,000 | Empty | 57.38 / 59.12 / 58.31 | 108.55 / 83.11 / 91.11 |

Every candidate first-catch p95 is below its history's baseline range, but these sequential local runs are not confidence intervals or a general latency guarantee. Acquisition still takes seconds near the tail under 300 simultaneous processes. Some individual hold/commit samples are much longer than their p95; wall-time instrumentation alone cannot attribute all of that time to SQL or process scheduling.

All twelve scenarios discovered 300 participants, consumed one activity each, and consumed none again: 3,600 successful worker results. Each scenario retains 300 hydrated bodies, 600 SQL writes, 300 committed artifact writes and 1,800 committed artifact reads. All stderr files were empty. Tests cover aggregate read-your-writes and rollback, known-but-not-standing peers, missing/done caller quorum, cap precedence, and ordinal numbering across aliases, gaps, rejoins and subsequent writes.

Raw local reports: `/tmp/square-catch-positive-before-{1,2,3}.json` and `/tmp/square-catch-positive-after-{1,2,3}.json`. Earlier reports lack these transaction timing fields and should not be mixed into this comparison.

## Follow-up: spreading writer acquisition retries

Writer acquisition now uses a per-transaction backoff window of 25, 50, then at most 100 ms. Each busy retry independently chooses an integer delay from 1 through that window. Read acquisition and other default retries remain fixed at 25 ms; a busy COMMIT still retries after 1 ms while retaining the writer. The shared helper applies this policy to artifact and host-ledger writes. Cancellation, rollback, synchronous callbacks, receipt selection and storage framing are unchanged.

This changes both retry frequency and synchronization, not jitter alone. At the cap the mean requested delay is 50.5 ms rather than 25 ms. The intent is to reduce contender overhead, not to pretend queue waiting is idle time: serial write hold plus commit already accounts for most of the previous catch duration. Wall-time measurements cannot prove how much of the benefit comes from scheduling or filesystem contention. There is no fairness guarantee; an individual contended retry can sleep longer than before. Uncontended attempts do not sleep.

Baseline `f004621` and the isolated writer-only candidate each ran three times with the same instrumentation and command above. Execution order was baseline 1, three rejected schema-normalization experiments, baselines 2–3, one broader retry pilot, then writer-only candidates 1–3. No build, test suite or second benchmark ran alongside a benchmark. This was not a randomized comparison; prior tables are separate experiments and should not be used as its baseline. The schema-normalization fast path showed no consistent benefit and was removed. The broader pilot is excluded from the results below.

| Metric | Before, 1,800 history | After, 1,800 | Before, 18,000 | After, 18,000 |
| --- | ---: | ---: | ---: | ---: |
| First catch API p95 (ms) | 2,942.43 | 2,696.24 | 3,314.33 | 2,703.95 |
| Empty catch API p95 (ms) | 114.52 | 83.35 | 107.99 | 85.06 |
| Whole catch phase p95 (ms) | 3,281.04 | 3,089.50 | 3,797.85 | 3,008.00 |
| Write acquisition p95 (ms) | 2,460.38 | 2,044.42 | 2,441.14 | 2,114.18 |
| Write hold p95 (ms) | 6.43 | 5.46 | 7.20 | 5.39 |
| Write commit p95 (ms) | 4.72 | 3.87 | 4.64 | 3.50 |
| Aggregate phase CPU (ms) | 14,791.25 | 12,797.97 | 16,050.74 | 12,994.48 |
| Artifact busy observations | 14,311 | 8,943 | 15,203 | 8,966 |

Cells are medians of three run-level measurements. First-catch p95 medians improve 8% and 18%, whole-phase medians 6% and 21%, and CPU 13% and 19%. Empty-catch p95 medians improve 27% and 21%; total busy observations fall 38% and 41%. Median run-level maximum write acquisition falls from 2,835.81 to 2,626.85 ms and from 3,064.84 to 2,656.63 ms; this is not a bounded maximum or a starvation guarantee.

| History | Call | Before p95 runs (ms) | After p95 runs (ms) |
| --- | --- | --- | --- |
| 1,800 | First | 3,518.32 / 2,942.43 / 2,797.10 | 2,479.32 / 2,696.24 / 2,829.63 |
| 18,000 | First | 2,791.81 / 3,314.33 / 3,457.89 | 2,576.67 / 2,759.20 / 2,703.95 |
| 1,800 | Empty | 114.52 / 114.76 / 100.27 | 83.35 / 84.59 / 82.22 |
| 18,000 | Empty | 118.99 / 107.99 / 63.28 | 108.44 / 85.06 / 61.79 |

Small-history consuming and whole-phase ranges overlap; large-history consuming ranges do not. Not every tail metric improves: the large-history median of each run's maximum COMMIT duration rises from 506.88 to 920.92 ms, despite the lower COMMIT p95. These local three-run results show lower contention overhead, not a universal latency improvement. Consuming catch still takes seconds near the tail with 300 simultaneous processes.

All twelve scenarios discovered 300 participants, consumed exactly one activity each and consumed none again: 3,600 successful worker results. Each retains 300 hydrated bodies, 600 SQL writes, 300 committed artifact writes and 1,800 committed artifact reads. All stderr files were empty. A new real-lock test checks cancellation before writer acquisition and successful single-callback execution on a subsequent transaction; existing tests retain busy COMMIT cancellation, same-result retries and cross-process receipt exclusion.

Raw local reports: `/tmp/square-lock-before-{1,2,3}.json` and `/tmp/square-lock-writer-{1,2,3}.json`. Discarded experiments are `/tmp/square-lock-schema-{1,2,3}.json` and `/tmp/square-lock-jitter-1.json`.
