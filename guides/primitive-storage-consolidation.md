# Artifact and resource primitive consolidation

> **Historical evidence, superseded API.** The factory/outcome shapes and split SDK defaults
> below describe the earlier implementation, not current instructions. Use the real
> [Square/Participant API](square-api.md); the independent factory and its design guide are deleted.


Deliverer evidence, not independent review or acceptance.

## Coordinates and scope

- Fixed baseline: `501ddc27d5520717f7a9e4d9a5b97406ea72022f`.
- Implementation: `c08a4fc5bb966b0bfe7429d10463d64e01ce5d35`.
- Final source integration: `d3f2faa5b79081638d9fa44295081b8e7b36dd05`, merging all accepted application work at `main` **`bf8ab04fe10505b1e3f40f7cbe3f206142a1a3d6`** (catch `c3a341e`, history `47aee31` ancestors). Application hunks auto-merged; conflicts in model/test imports were resolved by preserving history's removed query language, status's canonical queries and storage's relocated DTOs/actual primitive imports. Catch's public conversion/performance assertions remain. No application implementation outside the owned build/import hunk was changed by this lane.
- Own-lane measurements below remain separate from accepted catch/history/status changes; integrated totals follow them. The parallel application lanes retain actions/facade/views ownership; this lane changes only imports and build preparation/creation in `square-application.ts`. The final journal receipt identifies the captured candidate and observed target.
- No schema/version, host registry, native transport or wake-protocol changes.

## Deletion and responsibility map

| Removed concept | Surviving owner |
| --- | --- |
| `square-storage.ts`, file/memory cell aliases, snapshot write/create aliases | `artifact.ts`: canonical artifact access, publication, connections and transaction lifetime |
| `square-file-adapter.ts`, `openSquareArtifact`, `observeSquareChanges`, unused `probeSquare` | Actual callers use `artifact.ts` for storage-only work and `open-square.ts` for host-bound resources |
| `square-state.ts` guide/configuration branch; duplicate application/SDK validators | `artifact.prepareSquareBuild`: cap/throttle validation, default cap, optional throttle presence, normalized context/warmup, lazy synchronous guide cache |
| `square-state.ts` legacy SQLite framing | `square-sqlite.ts`: read-only owned-v1 recognition beside row framing/codecs |
| `square-state.ts` legacy payload validation | `square-migration.ts`: explicit legacy envelope, order/gap and assigned-reference checks, permissive finite route data and path-specific nonfinite rejection |
| General-model snapshot/runtime DTOs | `square-sqlite.ts`: explicit import/export DTOs, not runtime transaction state |
| Dead `StoredActHead`, `findParticipantName`, empty `ReceiverRoute` alias | Deleted; interchange routes use the existing `WakeRoute` type |

There are no forwarding stubs. The renamed build preparation is the actual implementation, not an alias. File SDK build, synchronous memory build and application build share it. Application build returns the normalized configuration from canonical creation rather than reconstructing it. Ordinary storage/resource imports perform no guide reads; the first build reads only its selected guides and caches them.

Necessary boundaries remain:

- `ports.ts` alone declares synchronous typed `SquareRead`, `SquareWrite`, `SquareArtifactPort`; no SQL handles or replacement snapshots enter behavior.
- `square-domain.ts` remains pure landing/allocation behavior; SQL effect persistence remains in `square-sqlite.ts`.
- `artifact.ts` retains its ordered queue, capability expiry, poisoned transaction handling, synchronous callback checks, close/cancellation drain and same-callback busy-COMMIT retry.
- `open-square.ts` composes artifact, captured environment, clock, ledger and transport, and owns resource close. Storage-only inbox observation uses artifact access directly.
- `square-migration.ts` alone decodes/converts legacy payloads, atomically and explicitly. Ordinary open recognizes owned v1 only to refuse with the recovery command.

Legacy activity/lease validation reuses existing row codecs because their persisted-JSON acceptance agrees. No runtime-wide permissive codec mode was introduced to accommodate nonpersistable own `undefined` keys. Legacy-only route validation remains deliberately separate: finite unknown route data, duplicate ordered routes, arbitrary finite epochs, exact owner strings, orphan assigned receipts, gaps, future read fences, empty/absent optional filters and mentions, NUL and surrogate strings all retain their existing meaning.

## Boundary and behavior evidence

`test/architecture-boundary.test.js` now parses and resolves local imports/exports rather than checking a filename-shaped regex that missed ordinary `./artifact.js`. It includes native plugin and separately compiled agent-delivery sources, including both changed OpenCode paths. Named artifact capabilities have specific callers; SQL imports stay inside artifact/migration. It exercises deliberate ordinary-artifact-import and native-helper SQL leaks, plus the existing transitive CLI/presentation traversal with a helper forwarding directly to artifact. Type-only facade `DiagnoseResult` is an explicit DTO exception, not snapshot access. Pure landing imports only model syntax and typed facts.

| Invariant | Evidence |
| --- | --- |
| One configuration path; synchronous memory build; lazy/cached guides | New `build-preparation` parity across memory/file/application, default/optional configuration, selected template and invalid options. Its import-time probe observes **both** `fs.readFileSync` and `fs.promises.readFile`, then asserts synchronous cached build reads. |
| Canonical creation before destination exists | `canonical-path` now uses a directory symlink with missing nested destination parents, then checks canonical presence/routes through the real path. Concurrent no-force publication remains covered by existing artifact/row suites. |
| Transaction lifecycle | `artifact`, `sqlite-storage`, `operation-cancellation`: expired capabilities, caught-driver poisoning, synchronous callbacks, exact rollback, same-callback busy COMMIT, abort during COMMIT, close drain and process recovery. |
| Build cancellation/publication | Existing real locked force-build cancellation leaves no delayed rebuild; cancellation after public link still returns committed success. |
| Explicit migration fidelity | `migration`: complete authority/revision equality, optional-field presence and permissive legacy values, order/envelope/reference rejection, exact nonfinite paths, rollback, concurrent migration and busy COMMIT. No auto-migration or new schema. |
| Row/perception behavior and bounded selection | Existing domain, catch, performance, SDK/application/CLI/MCP and native-adapter suites remain; revision observation does not hydrate historical bodies and catch hydrates its selected page. |
| Test caller ownership | Test callers/child scripts import actual owners, without replacement wrappers. The async-transition fixture uses typed header reads. The opt-in Claude driver uses typed landing and explicit export inspection rather than the retired mutable snapshot callback. |

A local opt-in-driver smoke executed setup/send/inspect through real artifact/ledger ports with an isolated fake receiver and **no Claude process or native route**. It is not live-runtime evidence. The existing opt-in real Claude test remains skipped by default.

## Verification

Repository scripts use the required sandbox preload. Raw logs are local evidence, not committed artifacts.

| Command | Result | Log |
| --- | --- | --- |
| `npm test` after preserving original low-level revision timing | 607 tests, 606 passed, 0 failed, 1 existing opt-in real-runtime skip; 57,466.954125 ms | `/tmp/primitive-storage-full3.log` |
| `npm run test:cli-process` | 48 passed, 0 failed/skipped; 22,589.868167 ms | `/tmp/primitive-storage-cli.log` |
| Focused boundary/configuration/canonical/transaction/migration/cancellation suites before target movement | 63 passed, 0 failed/skipped | `/tmp/primitive-storage-focused.log` |
| Final integrated catch/history/status + storage: build; architecture, build preparation, projections, automatic session, application boundary, performance, core, migration, artifact, SQLite transactions and cancellation | 154 passed, 0 failed/skipped | `/tmp/primitive-storage-final-focused.log` |
| Native adapter file after the revision-read correction | 34 passed, 0 failed/skipped | `/tmp/primitive-storage-adapters2.log` |

Two earlier full runs failed the same Pi next-change retry test, although that test passed alone. The untouched baseline adapter file passed. Investigation removed a newly introduced redundant asynchronous canonicalization from low-level inspection/revision reads; public diagnosis canonicalizes at its entry, and create/write/open keep their canonical ownership. This restores the old revision-read scheduling without modifying the notification protocol or weakening the test. The complete adapter file and full suite then passed. No failure was hidden by selecting only passing tests or increasing wait budgets.

The first formal audit and tender of `67be802`, and catch-integrated audit of `6d2d960`, satisfied 2/2 declarations. After history/status target movement, these earlier runs are not treated as final integrated verification: a fresh journaled `verified` audit/delivery runs both declared suites for the final merged candidate. Its receipt, not this prose, is the final attestation. The deliverer does not record an independent review verdict.

## Production-source measurement

Use the exact production classification and git-object recipe in [application-facade-delivery-evidence](application-facade-delivery-evidence.md), setting `BASE='501ddc2'` and `CANDIDATE='c08a4fc5bb966b0bfe7429d10463d64e01ce5d35'`. It covers every handwritten `.ts`, `.js`, `.mjs` outside the documented test/fixture/script/generated/vendor/build/docs/skills/internal exclusions, including native plugins and packages. `git ls-files --cached --others --exclude-standard` was also checked against the worktree: no new/untracked production source is omitted. The sole new source file is a test. Documentation descendants do not change the production result.

`git diff --numstat BASE CANDIDATE`, filtered by that same predicate, gives **317 added / 481 deleted / net −164 production lines**. Totals and all changed production paths:

```text
baseline files 110 lines 13926 bytes 732940
candidate files 107 lines 13762 bytes 726113
    +46 lines     +2599 bytes artifact.ts
     +0 lines        -8 bytes automatic-session.ts
     +0 lines        -8 bytes boundary-presentation.ts
     +0 lines        -8 bytes claude-delivery.ts
     +0 lines        -8 bytes claude-mod.ts
     +0 lines        -8 bytes delivery-health.ts
     +0 lines        +2 bytes inbox.ts
     +0 lines        -8 bytes list.ts
    -29 lines      -822 bytes model.ts
     +0 lines        -8 bytes notifications.ts
    +56 lines     +2316 bytes open-square.ts
     +0 lines        -8 bytes plugins/opencode/delivery.ts
     +0 lines        -8 bytes plugins/opencode/index.ts
    -10 lines      -583 bytes square-application.ts
   -127 lines     -4771 bytes square-file-adapter.ts
   +109 lines     +5442 bytes square-migration.ts
    +70 lines     +4472 bytes square-sqlite.ts
   -257 lines    -14048 bytes square-state.ts
    -22 lines     -1353 bytes square-storage.ts
     +0 lines        -9 bytes stream.ts
added 317 deleted 481 net -164 bytes delta -6827
```

### Integrated target accounting

The same recipe on final source integration `d3f2faa` separates this delivery from all accepted application lanes:

| Coordinate | Production files | Lines | Bytes |
| --- | ---: | ---: | ---: |
| Fixed baseline `501ddc2` | 110 | 13,926 | 732,940 |
| Accepted catch/history/status target `bf8ab04` | 110 | 13,846 | 728,155 |
| Integrated storage + all application lanes `d3f2faa` | 107 | 13,682 | 721,328 |

- Storage lane against final target: **317 added / 481 deleted / net −164 lines; −6,827 bytes** (unchanged from its isolated measurement).
- Already-accepted application target against fixed baseline: **net −80 lines; −4,785 bytes**.
- Cumulative candidate against fixed baseline: **608 added / 852 deleted / net −244 lines; −11,612 bytes**. This combined number is not claimed as storage-only reduction.
- No untracked production source; documentation-only descendants leave these totals unchanged. Unrelated dirty root-worktree `plugins/paseo/client/square-message.tsx` is not in this worktree or candidate; it was neither staged nor restored.

This is genuine deletion of alias/factory ladders, duplicate configuration/activity/lease validation, eager guide initialization and proven-dead declarations. Surviving responsibilities were moved to their owners and remain counted. No formatting compression, statement packing, excluded-path production offloading, generic framework, arbitrary comment deletion or unrelated production removal was used to meet the negative count. Necessary framing documentation was retained at its new SQL owner. Reduction is evidence, not by itself a quality verdict.

## Reference search

Search all production paths selected above, not merely root TypeScript:

```text
pattern: square-(storage|file-adapter|state)\.js
pattern: \b(createFileCell|createMemoryCell|createSquareSnapshot|writeSquareSnapshot|openSquareArtifact|observeSquareChanges|probeSquare|createSquareState)\b
(no production matches; rg exit 1 for both)
```

The three deleted paths are absent. Snapshot DTO references stay in `artifact.ts`, `square-sqlite.ts`, `square-migration.ts`; host/resource and behavior consumers use typed ports. Build validation strings occur only in `artifact.ts`. Resolved responsibility assertions above protect this map, rather than defending obsolete filenames.
