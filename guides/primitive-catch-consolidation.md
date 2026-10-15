# Canonical catch selection — delivery evidence

Deliverer evidence only, **not independent review or acceptance**.

## Coordinates and lane attribution

- Contract: `kei/one-canonical-catch-selection-36b2`.
- Fixed baseline: `501ddc27d5520717f7a9e4d9a5b97406ea72022f`.
- Implementation: `a2647054f45024ace2562001344285959fbecede`, following `d4df16e0db10d50c01b7ca6646b3c2bdb2871184`.
- Appointed worktree: `/Users/astrosheep/Developer/square/.keiyaku/wt/revolvingdoor`.
- Target checked and `git merge main` run at 2026-10-15 10:24 CST: already up to date, main still the fixed baseline. No storage/history/status lane changes are included in this implementation or its reduction claim. Later integration must preserve those lanes and rerun the declared scripts if production changes.
- This document is a documentation-only descendant of the implementation. The journal tender identifies the final candidate SHA.

## Removed responsibilities and their owners

| Removed | Canonical owner / retained boundary |
| --- | --- |
| `CatchDecision`, its unused `changed`, and its all-full perception map | `CatchSelection` contains raw selected activities, participant, cursor/remaining, say ordinals, clock, count/hold/cap/terminal facts. Pure `decideCatch` selects and writes receipts through `SquareWrite`, then captures these facts in that transaction. |
| `CatchSelectionResult` combining public activities with a second raw observation | `catchUp` admits the owner, checks the lease ID and invokes `decideCatch` in one receipt transaction, publishes presence best effort, and returns that exact selection. It no longer performs public conversion. |
| `CatchSelectionObservation` and `WatchPresentation` | `catchOwned` carries the same selection through completion, alongside actual lifecycle stop, waitStarted and replaced facts. No second selected-record wrapper or public page is built inside the lifecycle. |
| Completion's separate empty-result construction | `observeCatchSelection` captures the same concrete contract using `SquareRead` without marking seen. Only a completion without a committed selection calls it; it does not reopen or rehydrate a committed page. Empty ordinals are `{}` without an unnecessary selector call. |
| SDK public-result strip/rebuild and application raw page duplication | `caughtResult` maps to the established `CatchResult` at SDK/application exits. The application alone adds its existing terminal status and necessary projection metadata. `CatchProjection` has no raw `activities` array and no repeated terminalStatus. Optional nearby presence remains separate. |
| CLI reverse lookup from public ID into raw projection | CLI renders each public activity directly. Existing event rendering accepts `Activity` or `StoredAct` using small ID/reply accessors; no reconstruction of StoredAct or third display-event model. Raw archive/read/actorless inputs still work. |

Directed selection guarantees full visibility: `facts.directed` selects the landed audience relation; its heads require a say with an actor. Exact-ID catch checks both say kind and `directedAt` before selection. `perceiveActivity` settles any directed say to `full`, including listening/reply/bell routes. Therefore the deleted map carried no information and public conversion can attach `perception: 'full'` directly. The case/rejoin audience fixture now verifies the actual perception predicate for selected records, rather than checking the deleted map.

Necessary abstractions remain: typed transaction capabilities, pure selection, owner admission, leased waiting, application outcome and CLI/MCP adapters are distinct. No schema, native protocol, build/resource construction, generic operation receipt, generic dispatcher or optional-field selection bag was added.

## Preserved lifecycle and observation timing

- Lease acquisition retains its own transaction. Lease-ID validation, selection, markSeen, cursor, remaining and selected-page facts share the `catchUp` receipt transaction. A replaced waiter cannot insert a receipt in the gap after its heartbeat.
- Revision is still captured before evaluation. Heartbeats, hold-paused quiet expiry, replacement and ID-fenced signal-free cleanup remain unchanged. Already-active/replaced/capped/quorum remain distinct from empty-now/stale.
- Successful selection never falls back to a postcommit page/context read. Presence publication, lease release and notification enrichment remain best effort after authoritative consumption. Optional nearby presence can be unavailable without erasing the selected page.
- Empty terminal/quiet completion reads authoritative cursor and filtered remaining without markSeen. It never invents a null cursor after consumption. Seen holes, continuous cursor, historical catch and notification latest-join semantics remain unchanged.
- Public conversion now occurs later, at each API exit, rather than in the action/lifecycle. Selection facts still reflect the receipt transaction, not optional presence time. Empty completion's clock is captured when constructing that read-only selection; no selected body is hydrated. No SDK default or wire result changes are intended.

## Lane-local source reduction

Classification is exactly the production predicate in `guides/application-facade-delivery-evidence.md`: handwritten `.ts/.js/.mjs`, excluding its listed test/generated/script/documentation/vendor directories and test/spec/generated filename markers. All new production files would count; this lane adds none.

Measured from git objects, fixed baseline to the implementation above:

| Snapshot | Production files | Physical lines | Bytes |
| --- | ---: | ---: | ---: |
| `501ddc2` | 110 | 13,926 | 732,940 |
| `a264705` (catch lane only) | 110 | 13,903 | 731,909 |
| Delta | 0 | **−23** | **−1,031** |

Exact production patch counts:

| Path | Added | Deleted | Net lines | Net bytes |
| --- | ---: | ---: | ---: | ---: |
| catch-decisions.ts | 30 | 17 | +13 | +820 |
| cli/catch-presentation.ts | 4 | 8 | −4 | −160 |
| presentation.ts | 22 | 13 | +9 | +369 |
| square-actions.ts | 9 | 33 | −24 | −1,274 |
| square-application.ts | 30 | 41 | −11 | −497 |
| square-facade.ts | 4 | 10 | −6 | −289 |
| **Total** | **99** | **122** | **−23** | **−1,031** |

Reproduce patch counts with `git diff --numstat 501ddc2 a264705 --` followed by those six production paths; reproduce snapshot totals with the referenced evidence document's Python recipe, setting BASE to `501ddc2` and CANDIDATE to `a2647054f45024ace2562001344285959fbecede`. Counts include every production change in this lane, not another lane's removals. This is real responsibility deletion, not a claim based on relocation, packed statements, comment/whitespace removal, excluded-path offloading or unrelated deletion.

## Verification and concrete evidence

All test invocations use repository scripts or the `--import ./test/sandbox-env.js` preload. No live session notification or external runtime probe was used.

| Command / subject | Result | Raw local log |
| --- | --- | --- |
| Initial focused eight-file selection/lifecycle/renderer checks | 107 passed, 0 failed | `/tmp/catch-focused-1.log` |
| Focused page/fence/postcommit/public-render regressions | 39 passed, 0 failed | `/tmp/catch-focused-2.log` |
| `npm test` on `a264705` | 606 tests, 605 passed, 0 failed, 1 existing opt-in Claude runtime skip; 31,629.839875 ms | `/tmp/catch-full-2.log` |
| `npm run test:cli-process` on `a264705` | 48 tests, 48 passed, 0 failed, 0 skipped; 22,602.035709 ms | `/tmp/catch-cli-1.log` |

The first full run exposed an unnecessary `sayOrdinals([])` read on empty SDK completion. The existing SDK no-body-projection assertion was left intact; the observer now omits that empty selector call. The full scripts above passed after the fix. No failing test was hidden by narrowing the final commands.

Boundary evidence:

- `performance`: real raw selection hydrates only its bounded page; remaining uses directedCount; presence/rendering never rehydrates it. A new postcommit mutation fixture changes own count, hold and pending rows after selection and rejects any action-level read: returned ordinals/cursor/remaining/count/hold/clock still match the receipt transaction. A mismatched lease ID returns null without revision/receipt change.
- `application-boundary`: a real delivered receipt triggers failing host publication and a failing postcommit clock/presence read; catch still returns the consumed public page and its original projection facts, with enrichmentUnavailable and no raw activities projection. A later catch is empty. Existing real leased replacement, cancellation cleanup, hold/resume and quiet expiry fixtures pass, including the preserved consumed cursor after an actual say.
- `presentation`: public/raw rendering parity checks multiline body, activity ID, reply ID, mention metadata, done and listen; presence omits bodies. Raw read remains empty and actorless hold remains renderable.
- `row-domain`, `core`, `delivery`, `perception-projection`: filter-before-limit, exact repeat, original receipt timestamp, gap/cursor and latest-join differences remain tested. Obsolete changed assertions were replaced by actual receipts, or removed only where the immediately adjacent unchanged receiptAssignments equality already proves no write. No boundary assertion was weakened to preserve a retired mechanism.
- `operation-cancellation`, `square-facade`: commit survives response abort; SDK returns only its established CatchResult, no application body projections. CLI process coverage retains filtered continuation, mention/body visibility, stable IDs and lifecycle feedback. MCP continues serializing data only.
- Production reference search for `CatchDecision|CatchSelectionResult|CatchSelectionObservation|WatchPresentation|exposeCaught` returned no matches (excluding dist/node_modules); `git diff --check` passed. CLI has no `projection.activities.find` or raw reconstruction.

Formal audit and tender are journal acts; their receipts, not this deliverer document, establish Verification and waiting review. No self-review was performed.
