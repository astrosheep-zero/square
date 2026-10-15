# Canonical status and participant queries — delivery evidence

Deliverer evidence, not independent review or acceptance.

## Coordinates and lane attribution

- Fixed baseline: `501ddc27d5520717f7a9e4d9a5b97406ea72022f`.
- Isolated status implementation: `43afbc329da827be976232684bf176236a014196`, already containing raw latest removal and the CLI Map lookup.
- Shared renderer adoption: `9c61849b18704faef5b569f42bc45a832f491bb6`, copying only `presentation.ts` from catch commit `d4df16e0db10d50c01b7ca6646b3c2bdb2871184`. This dependency is **not** counted as status work.
- Final integrated source: `d8831c729017b69a50f095d9581ff0a0ca61875a`. This document's final update is documentation-only; the tender receipt identifies the final candidate.
- Integrated target: `main@47aee31156832bac23cf99e44bd9260bdcb8c1ee`, including accepted catch `c3a341e` and history. Both were merged in this worktree. The renderer adoption collapses exactly into accepted catch; only status changes remain relative to this target.

Using the production classification and git-object snapshot recipe in [application-facade-delivery-evidence](application-facade-delivery-evidence.md), with `BASE=501ddc27d5520717f7a9e4d9a5b97406ea72022f` and `CANDIDATE=43afbc329da827be976232684bf176236a014196`:

```text
baseline: 110 production files, 13926 physical lines, 732940 bytes
status:   110 production files, 13907 physical lines, 731887 bytes
production added 83, deleted 102, net -19 lines; -1053 bytes

  0 lines   +163 bytes cli/observation-commands.ts
-10 lines   -760 bytes decisions.ts
-26 lines  -1076 bytes square-application.ts
 -3 lines   -547 bytes square-facade.ts
+20 lines  +1167 bytes views.ts
```

`git diff --numstat 501ddc2 43afbc3` supplies the added/deleted counts; apply the same production predicate (handwritten `.ts`/`.js`/`.mjs`, excluding tests, generated/build/vendor code, scripts and documentation). There are no new production files. These isolated coordinates remain reproducible after target movement; other lanes' source reductions are never included in the -19. The shared renderer adds 22/deletes 13 lines in its separate commit and is excluded from status attribution. No minification, unrelated deletion, offloading, comment stripping, or weakened tests is used.

### Final residual and whole-source count

The same recipe on `BASE=47aee31156832bac23cf99e44bd9260bdcb8c1ee`, `CANDIDATE=d8831c729017b69a50f095d9581ff0a0ca61875a` isolates the final status residual after both accepted lanes:

```text
target:    110 files, 13865 physical lines, 729188 bytes
candidate: 110 files, 13846 physical lines, 728155 bytes
status residual: added 84, deleted 103, net -19 lines; -1033 bytes

  0 lines   +163 bytes cli/observation-commands.ts
-10 lines   -760 bytes decisions.ts
-26 lines  -1076 bytes square-application.ts
 -3 lines   -547 bytes square-facade.ts
+20 lines  +1187 bytes views.ts
```

The original isolated commit already includes raw latest removal and Map lookup. The final residual differs by one changed import line (+20 bytes): after history deletes its use of `ApplicationOutcome`, status explicitly retains that needed type. No renderer or other-lane deletion is counted in the residual.

For completeness, **whole integrated source** against fixed `501ddc2` is 110 files, 13846 lines, 728155 bytes: added 291/deleted 371, net **-80 lines/-4785 bytes**. This total includes catch/history and is not claimed as this lane's reduction.

## Removed responsibility and remaining owners

| Removed | Owner after consolidation |
| --- | --- |
| `coreStatus` aggregation and `StatusObservation` | Pure `queryStatus(facts, context, viewer)` assembles the final `StatusApplicationData` directly. `coreParticipants`/`ParticipantSummary` remain pure shared domain policy. |
| `statusPresentation`, `StatusPresentation`, `projection.status`, application status reshaping | Application owns one artifact read, optional viewer discovery and resource lifetime. The query returns final `{data, projection}` without an intermediate status representation. |
| `participantsPresentation`, `ParticipantsPresentation`, `projection.participants` | Pure `queryParticipants` returns one canonical data roster with shared presence annotations. |
| Projection copies of ordered participant summaries | Ordered names join to canonical data through a linear-time CLI Map. Presence classification and watcher-first ordering remain pure, shared policy. |
| Raw status latest duplicated beside public latest | CLI renders `data.latestActivity` through the catch-owned public/raw renderer and uses its public id in the continuation command. Perception and lifetime say ordinal remain additional projection facts. |

Full versus filtered roster is a real distinction: status data omits never-joined historical actor names, while participants data retains them. `knownParticipantCount` separately preserves the complete-roster continuation count; it is not `status.data.participants.length` or the standing count.

The amended guidance's reachable-latest clause is applied: the selector remains newest `say`/`done`. Both require an actor in valid storage, whereas actorless `hold`/`resume` and `read` are not selected. Therefore status has no reachable raw/public latest distinction. The conversion guard remains conservative, but no hypothetical duplicate projection is retained. History and other operations' genuine raw/public distinctions are untouched by this lane.

## Behavior and timing evidence

- `test/projections.test.js`: exact canonical status data, full versus filtered roster, absent duplicate projections, hold/cap/throttle fields, and read/actorless-hold exclusion from latest selection. Existing viewer perception, exact-spelling rejoin and bounded hydration assertions remain. Shared watching/recent/lingering policy remains read-only.
- `test/application-boundary.test.js`: configured named, discovered (including blank environment name), explicit blank, explicit override and ambient viewer; body perception and attention names; unchanged artifact state and ownership/presence ledger after status.
- `test/core.test.js`: status and participants continue sharing actual authored and receipt times, including a fresh rejoin and watcher.
- `test/process/square-cli-render.test.js`: the compact ten-person preview now includes a valid historical never-joined actor in the artifact. Status still hides that actor but its executable continuation uses the full count 14 rather than filtered count 13; participants prints the complete roster. Existing hold duration, exact rejoin, attention, clipping/public-id continuation and presence feedback remain covered.

No observation timing change is intended: optional viewer discovery still precedes status's resource read; the clock is sampled once inside the transaction, and all domain data, classification, perception and rendering annotations are assembled in that read. Queries perform no I/O or mutations themselves. SDK participant/snapshot shapes and MCP serialization of data remain unchanged. No join/claim is introduced.

Production reference search for `coreStatus|StatusObservation|StatusPresentation|ParticipantsPresentation|statusPresentation|participantsPresentation|StatusResult` returns no matches. Neither status nor participants has a duplicate roster in its projection. `git diff --check` passes.

## Verification

Final complete scripts ran on `d8831c7`, above accepted `main@47aee31`:

| Command | Result | Raw log |
| --- | --- | --- |
| `npm test` | 610 tests, 609 passed, 0 failed, 1 existing opt-in skip | `/tmp/status-full-final.log` |
| `npm run test:cli-process` | 48 passed, 0 failed | `/tmp/status-process-final.log` |

Focused build + sandboxed core/projections/application tests passed 53/53 before target integration (`/tmp/status-focused-final.log`); both complete scripts above include their final merged versions. No extra scenario matrix was added.

The skipped test is the existing opt-in shipped Claude mod real-runtime test. No live harness capacity probe was run.

Formal `kei audit kei/one-canonical-participant-status-e138 --include-dirty` reruns both complete declarations for the final integrated candidate; raw log `/tmp/status-audit-final.log`. The audit and tender receipts record the captured candidate, target and satisfied declarations. This is verification and delivery evidence only, not a reviewer verdict. The independent reviewer records acceptance separately.
