# Catch cold-path optimization

## Result and scope

Under the existing 300-process Pi-session workload, first-catch API p95 falls by **60.4% / 61.4%** for histories of 1,800 / 18,000 activities. These are reductions between the medians of three run-level p95s, not a guarantee for every run or operation. Whole catch-phase p95 falls by about **56%** for both histories.

The comparison is against `90752ba`, the current production implementation plus the same instrumentation, not an older, slower implementation. The benchmark represents Pi sessions without a Paseo route; it does not establish equal gains for Codex/Paseo sessions, emoji-only names, or native notification delivery.

## Two changes

- `model.ts`: try the existing Unicode text-name grammar before the full RGI emoji grammar. It accepts letters, numbers, marks excluding variation selectors, hyphens, underscores, and nonempty slash-separated segments. It is an exact subset of the original grammar; the original full matcher remains the fallback. `NAME_GRAPHEME_SOURCE`, also used by mention scanning, retains its original value.
- `participant-host.ts`: before discovering installed adapters, use the existing route resolver to check whether any candidate exists. No host ledger or no possible candidate means no route, without importing adapters that cannot be used. Real candidates still pass through the real capability check. These measurements predate the [native-first route policy](claude-native.md#native-first-routing-and-policy-holds); the optimization itself did not change route priority, harness identity, or publication failure isolation.

CPU sampling of the baseline pointed to cold name validation inside reader transactions and optional adapter module loading during catch. The changes remove that work rather than prewarm it or move it outside measurement. The sampling and this combined experiment do not establish each change's individual contribution.

SQLite storage, DELETE journaling, FULL synchronous durability, transaction validation, ownership/epoch fences, receipts, and retry policy are unchanged. Earlier lock/backoff/cache experiments did not show the required improvement and are not included. The earlier [COMMIT-gap investigation](catch-lock-investigation.md) measured preparation inside writers; it did not bound costs inside concurrent readers or optional postcommit module loading.

## Controlled comparison

```sh
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```

Node v26.10.0. Three runs of each variant, ordered B1, A1, B2, A2, B3, A3. Each command covers both histories. Baseline worktree: `/tmp/square-half-baseline-final`, detached at `90752ba`; candidate: the main worktree with the two changes above. Benchmark scripts were byte-identical. The changed compiled modules and benchmark script were hashed before and checked after every command. No other benchmark, test suite, build, or profile ran alongside the sequence; read-only review and test-source editing did occur. This is a local, alternating experiment, not a randomized or controlled-host latency guarantee.

The benchmark workload is unchanged: 300 processes, 2,048-byte historical bodies, a five-second idle window, bell discovery without filesystem hints, then open, recognize, first catch, empty catch, and close. First-catch timing covers the complete participant catch API. Whole-phase timing includes all those catch-phase steps; it is not one catch call.

### Median of three run-level measurements

| Metric | Before, 1,800 | After, 1,800 | Reduction | Before, 18,000 | After, 18,000 | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First catch API p95 (ms) | 3,923.86 | 1,554.02 | 60.4% | 3,568.86 | 1,378.74 | 61.4% |
| Whole catch phase p95 (ms) | 4,354.45 | 1,924.30 | 55.8% | 3,907.48 | 1,723.48 | 55.9% |
| Empty catch API p95 (ms) | 58.49 | 56.60 | 3.2% | 82.22 | 54.84 | 33.3% |
| Aggregate catch-phase CPU (ms) | 15,643.35 | 7,184.01 | 54.1% | 15,274.12 | 6,515.09 | 57.3% |

### Individual first-catch p95s

| History | Before B1 / B2 / B3 (ms) | After A1 / A2 / A3 (ms) |
| --- | --- | --- |
| 1,800 | 4,044.22 / 3,404.54 / 3,923.86 | 1,544.62 / 1,554.02 / 1,720.00 |
| 18,000 | 3,024.11 / 3,568.86 / 3,759.82 | 1,343.00 / 1,824.53 / 1,378.74 |

The second large-history pair improves by 48.9%, so the evidence does **not** say every paired run exceeded 50%. Both median reductions exceed 50%, and every candidate first-catch p95 is below every baseline p95 in its history group.

## Correctness evidence

All six commands exited successfully with empty stderr. Each of the twelve scenarios had 300 ready/completed workers and discovered all 300 participants. The raw per-worker reports were separately checked, including `remaining` (which the benchmark's built-in success gate does not assert): every worker consumed exactly one activity, had zero remaining, and consumed nothing again. That is 3,600 successful worker outcomes.

Every scenario retained 300 hydrated bodies, 600 SQL writes, 300 committed artifact writes and 1,800 committed artifact reads. The recorded COMMIT execution-plus-gap invariant held. No workload or instrumentation was removed to obtain the reduction.

Focused regression coverage preserves explicit expected acceptance/rejection for Unicode text, complete emoji, slash boundaries, selectors, joiners and malformed strings. A fresh-process module-loading test verifies that no-candidate drafting imports neither adapter, and that real Codex and Pi-plus-Paseo candidates still resolve through installed adapters.

`npm test` passed (678 passed, one opt-in runtime test skipped); the CLI process suite passed all 48 tests. Running the new module-loading test against the unchanged baseline fails at its zero-import assertion (two adapters loaded), providing a negative control. Rebuilding for regression tests preserved the measured production module hashes. An independent review recomputed p95s from raw worker timings and verified the reported medians and outcomes.

Local raw evidence: `/tmp/square-half-final-{before,after}-{1,2,3}.{json,err,exit,sha,integrity}`. Summary and per-worker assertion audit: `/tmp/square-half-final-summary.{py,json}`. The earlier pilot is excluded from the table.
