# Catch lock investigation: preparation, COMMIT retries, and WAL

## Question and finding

Follow-up: [catch cold-path optimization](catch-cold-path-optimization.md) removes unnecessary name-validation and adapter-loading work without adopting WAL; its separate repeated comparison meets the 50% first-catch p95 target.

Does SQL compilation explain the multi-second queue under 300 processes, or is the critical path mainly lock occupancy?

For the current DELETE-journal implementation, preparation inside committed write transactions accounts for about 6% of their cumulative hold-plus-commit time. About 84% of COMMIT wall time occurs **between** synchronous COMMIT calls following BUSY, not inside SQLite calls. Compilation is not the leading measured direct contributor to writer occupancy.

An isolated WAL + FULL experiment removes observed COMMIT BUSY and retry gaps, but does not remove the overall latency problem. Pre-COMMIT hold time increases, ranges overlap, and one large-history WAL run regresses. Do not ship a journal-mode change on this evidence alone.

## Measurement boundaries

`scripts/benchmark-idle-wait.mjs` now records, per connection/origin and transaction mode:

- `holdPrepareMs`: synchronous prepare-call wall time after successful BEGIN and before the first COMMIT attempt, including failed prepares.
- `commitExecMs`: synchronous COMMIT-call wall time, divided into successful, BUSY, and other-error calls.
- `commitGapMs`: time between the end of a COMMIT call and the start of its next attempt.
- `commitMs = commitExecMs + commitGapMs`, within rounding.

Only committed transactions contribute samples; rollback discards the transaction sample. Global prepare counters separately retain all attempts. The synchronous measurements include off-CPU time and wrapper overhead; they are **not CPU or fsync measurements**. Retry gaps include timers, scheduling, and caller work. These measurements cannot distinguish how long readers remain active from how long the writer waits to be scheduled again. A preparation share is not an upper bound on all indirect benefits of reducing preparation in concurrent readers.

In DELETE mode, a writer holding a RESERVED lock needs existing readers to release SHARED locks before it can obtain EXCLUSIVE for commit. BUSY establishes contention; the split establishes where elapsed time occurs. It does not establish that disk synchronization itself costs the full COMMIT wall time. See [SQLite locking](https://www.sqlite.org/lockingv3.html).

## Controlled experiment

Production storage code is `a1bd798`; the concurrent UI-only commit `446e204` does not change this path. The temporary detached worktree `/tmp/square-wal-investigation` has exactly two production-line changes: new artifact creation requests WAL, and the row validator expects WAL. The host ledger remains DELETE. Both variants retain FULL synchronous writes and the same writer retry policy. This experiment supports **fresh artifacts only**, not migration of existing artifacts.

A disposable positive control confirmed WAL, synchronous=2 (FULL), wal_autocheckpoint=1000, and real `-wal`/`-shm` files. Benchmark scripts were byte-identical in both locations; production module hashes on the baseline matched before and after measurement.

```sh
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```

Three runs per variant, each covering histories of 1,800 and 18,000 activities. Execution order was D1, W1, D2, W2, D3, W3; no second benchmark or test suite ran alongside them. An initial raw-report audit ran during D2, so this was not a completely quiescent host. The order is alternating, not randomized; three local runs do not give a general latency guarantee. Both variants used the new instrumentation, so do not compare their absolute timings directly with previous instrumentation's reports.

## Results

Each cell is the median of three run-level measurements. Writer timings below are cumulative across 300 committed write transactions, **not p95s**. Parent and child fields overlap; independently calculated medians need not add up.

| Metric | DELETE, 1,800 | WAL, 1,800 | DELETE, 18,000 | WAL, 18,000 |
| --- | ---: | ---: | ---: | ---: |
| First catch API p95 (ms) | 3,287.06 | 2,959.93 | 3,626.62 | 3,162.81 |
| Empty catch API p95 (ms) | 85.71 | 33.84 | 83.40 | 28.47 |
| Whole catch phase p95 (ms) | 3,797.29 | 3,255.36 | 4,104.10 | 3,513.85 |
| Writer hold before COMMIT, total (ms) | 2,137.47 | 2,483.41 | 1,556.86 | 2,872.93 |
| Preparation within writer hold, total (ms) | 215.62 | 589.84 | 218.35 | 276.82 |
| Writer COMMIT wall, total (ms) | 1,340.74 | 70.33 | 2,224.91 | 710.17 |
| Writer synchronous COMMIT calls, total (ms) | 204.95 | 70.33 | 305.45 | 710.17 |
| Writer inter-COMMIT gaps, total (ms) | 1,166.90 | 0 | 1,881.57 | 0 |
| Artifact COMMIT BUSY observations | 290 | 0 | 276 | 0 |
| Aggregate catch-phase CPU (ms) | 15,107.57 | 13,469.20 | 15,766.89 | 13,891.08 |

For DELETE, calculate shares within each run before taking their median:

- Held prepare / (hold + COMMIT): **6.49% / 6.26%** for small/large histories.
- Inter-call gap / COMMIT wall: **84.07% / 84.57%**.

WAL first-catch p95 medians are about 10% and 13% lower, but individual runs matter:

| History | DELETE first-catch p95 runs (ms) | WAL first-catch p95 runs (ms) |
| --- | --- | --- |
| 1,800 | 3,052.04 / 3,788.98 / 3,287.06 | 2,959.93 / 3,560.27 / 2,272.82 |
| 18,000 | 3,626.62 / 3,449.42 / 4,044.86 | 3,162.81 / **4,963.89** / 2,626.30 |

WAL removes the measured BUSY-commit mechanism but changes I/O, checkpointing, and reader concurrency too. The larger pre-COMMIT hold and variability are observations, not proof of any one scheduling cause. The second large-history WAL run is slower than every DELETE run. These results do not justify a claim of stable overall acceleration.

All twelve scenarios discovered 300 participants, consumed exactly one activity per participant, and consumed none again: 3,600 successful worker outcomes. Each scenario retained 300 hydrated bodies, 600 SQL writes, 300 committed artifact writes and 1,800 committed artifact reads. All six commands exited successfully with empty stderr. The expanded bounded instrumentation self-test passed, including real busy COMMIT splitting, failed preparation, origin separation, and rollback/reset.

Raw reports: `/tmp/square-journal-{delete,wal}-{1,2,3}.{json,err,exit}`. Local summary: `/tmp/square-journal-summary.mjs`. The temporary WAL changes are **not** in production.

## What remains before any WAL adoption

- Existing DELETE V2 artifacts and old readers need an explicit compatibility/migration decision; the experimental validator simply refuses them.
- WAL contains committed state until checkpointed. Backup/move/recovery, alias paths and directory permissions must account for it. Standard WAL requires processes on the same host.
- Observe long readers, WAL size, checkpoint timing and recovery. This short benchmark does not measure long-lived WAL growth or a final last-connection checkpoint; its parent artifact connection remains open. `artifactBytes` counts only the main file, not sidecars.
- `list.ts` uses main-file mtime for `lastActiveAt`; WAL commits need not update it. The existing file watcher does recognize `-wal`, but a `--no-hints` benchmark does not validate native notifications.
- Retain FULL durability. WAL + NORMAL would change power-loss guarantees and is not an equivalent performance comparison.

See [SQLite WAL](https://www.sqlite.org/wal.html) for concurrency, checkpointing, durability and operational tradeoffs. Next investigation should target why read transactions and scheduling prolong the retry gaps, or reduce redundant transaction/validation work, rather than assume compilation or a journal-mode toggle alone resolves the queue.
