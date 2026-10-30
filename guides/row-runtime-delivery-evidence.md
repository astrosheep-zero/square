# Row runtime delivery evidence

Candidate implementation: `833d6f15c9071767eb49a9562a4c42a93c6f4000` plus post-review removal of three dead runtime exports and benchmark phase baselines. Baseline: `99679eb2905dde5f282025bc7f5494f7da065e54`. This report is Deliverer evidence, **not independent review or acceptance**. Explicit migration is a separate delivery; no publication, live migration, host service change, or remote native presentation was performed.

## Deletion and replacement

| Removed mechanism | Current owner / replacement |
|---|---|
| Blob-backed artifact read/transact, full-state clones and JSON equality change detection | `artifact.ts` queues synchronous guarded typed callbacks; `square-sqlite.ts` reads selected rows and tracks actual authoritative writes. Revision advances once per changed transaction. |
| Whole-history fold on normal operations; replay delivery/perception closures | `square-domain.ts::deriveLanding` maintains participant, attention and ordered audience indices once at landing; `runtime.ts` computes cursor/presence/terminal from narrow domain facts. |
| `FromState`/delta bridges and old core append/observation update helpers | Removed. `SquareWrite.land/markSeen/putLease/removeLease/replaceRoutes` are the finite domain mutations. Memory uses the same SQLite driver in `:memory:`, not a second selector/policy implementation. |
| Renderer `.state` inputs and replay-based ordinal/perception lookup | `views.ts`, `perception-projection.ts` and presentation operations settle selected bodies, ordinals, counts and perceptions inside the transaction; renderers receive detached values. |
| Join/status/done snapshot loads for counts | `joinFacts`, standing counts, roster/status aggregates and header reads. Public SDK snapshot is no longer used by these production callers. |
| Global whole-history notification/wake enumeration | Bodyless `pendingAudience` groups with a captured activity upper bound and recipient join coordinates; receivers use their own `directed` relation. Scans advance past withheld groups and do not restart on unrelated writes. |
| Whole-history native/Claude currentness and cancellation | Exact pending facts, ordered routes, lease and captured host fences; cancellation selects activity heads by descending coordinate and tests timestamp. Host/network work stays outside artifact transactions. |
| Preliminary full load before file-backed open/probe/wait | Validated header/schema boundary, revision-only observer; selected row validation on access. Full doctor is explicit. |
| Tests tied to removed callback-state mutation and serialization details | Replaced by typed transaction, differential oracle, sparse receipt, projection, process-race and recovery evidence. Behavioral coverage retained. |

### Remaining references and explicit exceptions

Searches were run over production `.ts/.js/.mjs`, excluding dependencies/generated output, and over call sites:

```sh
rg -n 'FromState|foldActivities|foldSquare|cloneState|loadSquare|readSquareState|writeSquareState|square_snapshot|\.state\b|SquareState' --glob '*.{ts,js,mjs}' --glob '!test/**' --glob '!scripts/**' --glob '!dist/**' --glob '!node_modules/**'
rg -n 'validateSquareState|exportSqliteState|initializeSqlite|writeSquareSnapshot|createSquareSnapshot|createMemoryCell|writeSquareFile|deriveLanding|landingFacts|\.snapshot\(' --glob '*.ts' --glob '!dist/**' --glob '!node_modules/**'
```

- No production `FromState`, old fold/clone/load functions or hot `.snapshot()` caller remains.
- `SquareState` remains an explicit initialization/import/export format in `model.ts`, `square-state.ts`, `square-sqlite.ts`, `artifact.ts`, `square-storage.ts` and `square-file-adapter.ts`. It is not a transaction result or partial fact projection.
- `square-state.ts` retains legacy validation for the separately implemented migration and test oracle. Normal v1 recognition validates framing and refuses with `migration_required`; it never decodes v1 history. Common per-activity validation is also used by the row codec.
- `artifact.ts::readSquareSnapshot` and `square-sqlite.ts::exportSqliteState` are explicit export/integrity capabilities. Doctor intentionally reads all authority and compares maintained indices against a rebuild. Neither is a hot-runtime fallback.
- `createSquareSnapshot` initializes a new artifact. `writeSquareSnapshot/writeSquareFile` are explicit build `--force`/fixture import, not whole-state transaction callbacks. Existing v1 still refuses before destructive work. `initializeSqlite` also supplies the migration's shared rebuild; it calls the same `deriveLanding`, not another production fold.
- Public SDK `snapshot().delivered()` copies raw receipt assignments into a detached exact-owner Set; it does not retain a query or transaction capability and copies no activity history.
- `.state` matches elsewhere are participant/admission states, transport outcomes or Claude's native `$.state` API, not artifact snapshots. `packages/agent-delivery` remains untouched.
- `square_snapshot` in the benchmark is instrumentation for detecting forbidden legacy reads, not a runtime path.

### Production source size

The Contract's exact `git diff --numstat` script, counting tracked production `.ts/.js/.mjs` and excluding tests/fixtures/scripts/dist/dependencies/reference, reports:

| Candidate | Added | Deleted | Net |
|---|---:|---:|---:|
| Initial runtime (`6a4f818`) against fixed baseline | 2,396 | 2,601 | **-205** |
| Post-review runtime against fixed baseline | 2,387 | 2,598 | **-211** |

Documentation and benchmark/test additions are excluded by the prescribed rule; no production code was moved into excluded paths. Negative size alone does not establish quality: independent review must still judge duplication, unnecessary abstraction and formatting-only reduction. The initial reviewer confirmed raw -205 but found formatting contributes substantially; their uniform synthesized/comment-free TypeScript-printer diagnostic was 7,881 -> 7,960 (+79), not a new numerical gate. That concern is not waived by this report. Substantive deletions include core `createFoldAccumulator/applyActivity/finishFold/fold/replayLandedAudiences/perceive`, runtime `foldedState/countSays/sayNumberFor/recordObservation/writeWatchLease/removeWatchLease`, decisions `coreActivities/buildParticipantStatuses`, actions `storeActs/committedActivity`, delivery `deriveDeliveryModel/perceiveActivity/isActivitySeen`, and storage `cloneState/assertCellOpen/isThenable/discardThenable`. Their replacements are mapped above. Post-review also deletes the unused `matchesMentionTarget/resolveRosterName/actStableIndex` exports and their unused imports. No formatting-only cleanup was added to obtain the post-review delta. Migration's Deliverer reported the combined candidate at +2,527/-2,603 = -76; that candidate is not this runtime tender and still requires its own verification/review.

## Behavioral verification

Executed against the implementation above, sandboxed:

- `npm test`: **556 pass, 0 fail, 1 skip**, 97.467s. The skip is the existing opt-in shipped Claude real-runtime scheduling/lifecycle test, not a row-runtime assertion.
- `npm run test:cli-process`: **48 pass, 0 fail**, 47.833s.
- Contract source-count command: pass, net -205.

Earlier integrated full-suite execution had 520 pass / 7 fail. Actual stale fixture APIs and injected-clock mismatches were corrected; three timing failures then passed isolated and in the final full run. No timeout/assertion was relaxed to hide them.

Evidence locations:

| Invariant | Tests |
|---|---|
| Landing audience priority and directed attention, including mixed spelling, reply/mention/listen/ignore/bell and departure | `test/row-domain.test.js` |
| Sparse receipts, exact raw owners/orphans, unseen hole vs later catch, repeat no-op, filtered remaining, historical catch vs latest-join pending, distinct cursor/presence | `test/row-domain.test.js`, `test/perception-projection.test.js` |
| Exact v2 schema, optional field preservation, immutable detached facts, expired capabilities, synchronous callbacks, caught storage failure rollback, no-op revision, selected corruption vs doctor | `test/artifact.test.js`, `test/core.test.js` |
| Two real processes serialize catches; process death rolls activity and indices back; busy COMMIT retains callback/result; abort preserves reason; revision read has a positive SQL control | `test/sqlite-storage.test.js` |
| Search filtering before limit; audience paging through empty intersections; context by existing positions; exact-spelling rejoin annotation; detached SDK receipt closure; stream advances bodyless raw page | `test/projections.test.js` |
| Complete recipient discovery beyond 100 withheld rows; expiry-only reconsideration; failed evidence does not spin; isolation and repair of unreadable binding | `test/session-pending.test.js` |
| Bodyless sweep advances through suppressed groups under unrelated writes, ignores new rows beyond captured bound; dispatch remains roster-major | `test/delivery-operations.test.js` |
| Native epoch/cancel/claim/send fences, clipping and Pi omitted-batch handling remain green | Existing native, delivery, Pi and automatic-session tests in full suite |

Raw local logs: `/tmp/doghouse-test-final.log`, `/tmp/doghouse-cli-final.log`. These paths are ephemeral; the reproducible commands and summarized results above are the durable evidence.

## Actual 300-process capacity probes

Node v26.10.0, disposable artifacts and a shared synthetic host ledger. Every run uses **300 independent worker processes on the same artifact**. In the initial reports below, idle CPU excludes setup but idle SQL/ledger counters are **cumulative receiver startup plus idle**, not isolated idle. The initial `sessionSetupExcluded:true` label was too broad; independent review caught this. Startup baselines were not retained in those old reports, so their unknown contribution is not fabricated or subtracted. Post-review instrumentation captures actual before-idle/before-catch counter baselines and reports deltas alongside the cumulative per-worker records; corrected measurements are recorded separately below. The required active command defaults to **both 1,800 and 18,000 unrelated rows**, each with 2,048-byte bodies. The producer lands a bell directly without notification push; `--no-hints` disables fs.watch only in benchmark workers. Authoritative reconciliation remains unchanged. This measures local projection discovery and concurrent catch, not native remote message landing or an SLA.

```sh
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```

Both exact required commands exited 0. The active command completed both history sizes with 300 ready / 300 complete each. Each worker discovered one bell, caught exactly one activity, then ordinary catch consumed zero again. The fixed 20s discovery deadline and existing derived 145s phase guard were retained.

### Initial required standalone idle run (startup-inclusive counters)

300 ready / 300 complete; five-second idle phase: **0 hydrated rows/bytes**, CPU total 3,909.983ms (mean 0.2563% per worker), 6,536 header statements, 38,208,000 ledger bytes / 6,802 operations, 0 busy errors. Positive controls: 3 header reads, 1 hydrated body / 2,090 encoded bytes, 6,308 seed write statements (at least 2,101 required), 2,400 ledger setup operations.

### Initial required active comparison (idle counters include startup)

All CPU/statement/byte/busy counts below are totals across 300 workers; latency and wall time are per-worker distributions. Bytes are instrumented encoded hydrated-row bytes, not SQLite page I/O.

| Metric | 1,800 unrelated rows | 18,000 unrelated rows |
|---|---:|---:|
| Ready / completed | 300 / 300 | 300 / 300 |
| Seed acts / ms / artifact bytes | 2,101 / 4,025 / 7,700,480 | 18,301 / 54,582 / 75,366,400 |
| Idle hydrated rows / bytes | 0 / 0 | 0 / 0 |
| Idle CPU ms / mean per-worker CPU % | 3,636.661 / 0.2406% | 3,273.842 / 0.2175% |
| Startup + idle header statements | 5,990 | 5,754 |
| Startup + idle ledger bytes / operations | 38,208,000 / 6,212 | 38,208,000 / 5,936 |
| Bell producer commit wall ms | 117 | 50 |
| Discovery latency p50 / p95 / max ms | 2,311 / 2,883 / 2,920 | 1,111 / 2,202 / 2,238 |
| Discovery body rows / bytes | 300 / 18,000 | 300 / 18,000 |
| Discovery head rows / header statements | 300 / 1,654 | 300 / 1,624 |
| Discovery CPU ms | 4,428.157 | 3,635.459 |
| Discovery ledger bytes / operations | 19,104,000 / 1,130 | 19,104,000 / 1,142 |
| Discovery busy errors / busy COMMIT | 0 / 0 | 0 / 0 |
| Discovery COMMIT attempts / execution ms | 677 / 130.135 | 662 / 15.854 |
| Catch per worker / reconsume total | 1 / 0 | 1 / 0 |
| Catch wall p50 / p95 / max ms | 25,673.901 / 28,002.005 / 28,372.043 | 16,462.888 / 18,329.207 / 18,594.534 |
| Catch body rows / bytes | 300 / 18,000 | 300 / 18,000 |
| Catch head rows / header statements | 2,100 / 3,906 | 2,100 / 3,900 |
| Catch CPU ms | 55,637.897 | 41,478.691 |
| Catch write statements | 600 | 600 |
| Catch busy errors / busy COMMIT | 191,548 / 145 | 129,827 / 104 |
| Catch COMMIT attempts / execution ms | 1,345 / 4,432.922 | 1,304 / 714.977 |
| Catch ledger bytes / operations | 171,936,000 / 2,700 | 171,936,000 / 2,700 |

Controls for **each** active size: 3 header reads, 1 body / 2,090 bytes, 2,400 ledger operations. Seed write counts were 6,308 (>=2,101) and 54,908 (>=18,301). Legacy whole-state reads were zero throughout. Instrumentation wraps actual SQLite prepare/exec and Statement all/get/run/iterate, classifies payload hydration including SELECT *, and counts positive body/header/write/ledger controls. Its self-test also induces a real SQLite busy condition. Failed runs emit received phase counters and exit nonzero rather than inventing missing results.

### Failed/diagnostic probes and interpretation

An earlier exact active command failed the 145s guard with all 300 workers ready. That is an **incomplete run, not a capacity pass**; the failure's cause was not established. Its old report did not retain enough phase detail, so partial failure reporting was added before the successful required rerun. An intervening diagnostic `--history 1800` run completed 300 workers, but counted only one size and was not used to satisfy the comparison requirement. No process count or deadline was lowered/extended to obtain the final pass.

The completed comparison establishes no unrelated-history body hydration in receiver idle/discovery/catch phases. It does **not** establish constant-time SQL index counts, a fast catch SLA, or cross-process monitor deduplication. Simultaneous write acquisition causes substantial busy retries and tens-of-seconds catch wall time; COMMIT execution duration is not total waiting duration. Host-ledger parsing still contributes substantial bytes/work and is intentionally unchanged by this delivery. The larger-history run being faster is a run observation, not proof that adding history improves performance.

Raw local reports: `/tmp/doghouse-benchmark-300-idle.json`, `/tmp/doghouse-benchmark-300-active-final.json` (includes individual workers), corresponding `.err` files; earlier failure `/tmp/doghouse-benchmark-300-active.err`; diagnostic `/tmp/doghouse-benchmark-300-diagnose.json`. Initial Contract audit satisfied 4/4 at `6a4f818` (receipt `01M4XSZ9REQ28W39MBJFW7AJ0G`), but the subsequent tender's fresh verification was interrupted by the Deliverer's insufficient outer tool timeout and did not establish a current satisfied gate. Independent review was **unsatisfied**, receipt `01M4XTE345H4DE4ZVWHC3VBXK8`, citing three dead exports, stale verification and the counter attribution caveat. That initial candidate is not accepted. The corrected complete candidate requires new formal verification and independent review.

### Corrected phase-attributed probes (`daed87f`)

Both exact required commands were rerun after the review corrections and **exited 0**: standalone idle 300 ready / 300 complete, active 300 ready / 300 complete at **both** history sizes. Before-idle counters are actual worker snapshots taken after `go`, aligned with the CPU/wall start; idle metrics subtract them. Before-catch snapshots are taken after the catch signal, aligned with catch CPU/wall start. Discovery subtracts the preceding idle-end snapshot. Reports retain these baselines, cumulative end snapshots and individual deltas; no old unknown startup contribution was estimated.

Standalone corrected idle: CPU 3,642.488ms, mean 0.2418% per worker; **0 hydrated rows/bytes**, **0 ledger bytes**, 1,558 header statements, 1,580 ledger operations, 0 busy errors. The excluded measured receiver-before-idle baseline contained 3,704 header statements, 38,208,000 ledger bytes / 3,904 operations and 0 hydrated bodies. Thus a zero idle ledger byte result does not mean the ledger counter was inactive.

| Corrected metric (worker totals unless distribution) | 1,800 unrelated rows | 18,000 unrelated rows |
|---|---:|---:|
| Ready / complete | 300 / 300 | 300 / 300 |
| Seed ms / artifact bytes | 2,864 / 7,700,480 | 29,234 / 75,366,400 |
| Measured before-idle header statements | 4,402 | 3,560 |
| Measured before-idle ledger bytes / ops | 38,208,000 / 4,568 | 38,208,000 / 3,760 |
| Idle body rows / bytes / ledger bytes | 0 / 0 / 0 | 0 / 0 / 0 |
| Idle CPU ms / mean per-worker CPU % | 3,313.042 / 0.2198% | 3,546.703 / 0.2355% |
| Idle header statements / ledger ops / busy | 1,552 / 1,596 / 0 | 1,568 / 1,604 / 0 |
| Bell producer commit wall ms | 29 | 40 |
| Discovery latency p50 / p95 / max ms | 1,430 / 1,992 / 2,026 | 1,532 / 2,051 / 2,066 |
| Discovery body rows / bytes / head rows | 300 / 18,000 / 300 | 300 / 18,000 / 300 |
| Discovery header statements / CPU ms | 1,666 / 3,472.307 | 1,660 / 3,550.010 |
| Discovery ledger bytes / ops | 19,104,000 / 1,164 | 19,104,000 / 1,126 |
| Discovery busy / COMMIT busy | 0 / 0 | 0 / 0 |
| Discovery COMMIT attempts / execution ms | 683 / 4.981 | 680 / 97.996 |
| Catch per worker / reconsume total | 1 / 0 | 1 / 0 |
| Catch wall p50 / p95 / max ms | 17,606.704 / 19,263.257 / 19,432.453 | 15,233.103 / 17,050.284 / 17,369.085 |
| Catch body rows / bytes / head rows | 300 / 18,000 / 2,100 | 300 / 18,000 / 2,100 |
| Catch header statements / CPU ms | 3,902 / 40,895.422 | 3,900 / 37,722.763 |
| Catch write statements / busy errors | 600 / 129,666 | 600 / 116,260 |
| Catch COMMIT attempts / busy / execution ms | 1,328 / 128 / 658.882 | 1,317 / 117 / 450.338 |
| Catch ledger bytes / ops | 171,936,000 / 2,700 | 171,936,000 / 2,700 |

Positive controls remain 3 header reads, 1 body / 2,090 bytes, seed writes 6,308 (>=2,101) and 54,908 (>=18,301), 2,400 ledger setup operations, and zero legacy reads. The instrumentation self-test passed. A separate **two-worker diagnostic**, not capacity evidence, verified idle/catch deltas against actual nonzero startup baselines and aggregate sums. The 300-process reports' idle deltas/aggregate ledger sums were likewise checked against their actual retained baselines.

Corrected raw records: `/tmp/doghouse-benchmark-300-idle-corrected.json`, `/tmp/doghouse-benchmark-300-active-corrected.json` and corresponding `.err`; diagnostic `/tmp/doghouse-phase-baseline-control.json`. The prior reports remain available rather than being overwritten. These corrected results establish phase attribution and completion, not a faster catch SLA or a host-ledger redesign.
