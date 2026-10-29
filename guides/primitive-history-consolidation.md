# History query consolidation — delivery evidence

> **Historical evidence, superseded API.** The factory/outcome shapes and split SDK defaults
> below describe the earlier implementation, not current instructions. Use the real
> [Square/Participant API](square-api.md); the independent factory and its design guide are deleted.


Deliverer evidence, not an independent review or acceptance.

## Coordinates and lane-local reduction

- Contract: `kei/one-history-query-language-above-f34a`.
- Fixed baseline: `501ddc27d5520717f7a9e4d9a5b97406ea72022f`.
- Lane-only implementation: `6812c46cb3fc0c6f1e10bed92b3f6173d6fdba90`, including the native consumer amendment on top of `2ee7658075b5013f8f043555b71efc1975a794a0`, containing no imported parallel-lane changes.
- Integrated source: `3251d021353db9d108e89b210a1e0d245fd41a30`, merging accepted catch target `c3a341ef8b2da905da006f3e0fd2a6eea6d39344`. This evidence is its documentation-only descendant. Only the runtime/catch-decisions import block conflicted: catch's canonical selection imports and history's `presenceAnchor` were retained together; retired catch imports were removed. History's selector/public-mapping imports and both lanes' behavior remain intact.
- Appointed worktree: `/Users/astrosheep/Developer/square/.keiyaku/wt/bermuda`.

Using the production classification and git-object snapshot recipe in [application-facade-delivery-evidence](application-facade-delivery-evidence.md#exact-committed-production-count), with the fixed baseline above:

```text
baseline  files 110  physical lines 13926  bytes 732940
history   files 110  physical lines 13888  bytes 730219
production added 114  deleted 152  net -38
production byte delta -2721

                     added deleted net lines  net bytes
automatic-session.ts     4       4         0         -9
model.ts                 0      21       -21       -622
square-application.ts   40      11       +29      +2320
square-facade.ts         9      11        -2       -341
views.ts                61     105       -44      -4069
```

The table above is the lane-only count, not a claim on imported catch deletions. The integrated source has 110 production files, 13,865 physical lines and 729,188 bytes: combined delta -61 lines / -3752 bytes against the fixed baseline. Independently comparing accepted catch `c3a341e` to integrated source `3251d02` gives this lane's exact residual **+114/-152 = -38 lines, -2721 bytes**, over the same five production paths as above.

The count includes every handwritten production `.ts`/`.js`/`.mjs` file selected by that recipe, including new files (there are no new production files in this lane). Tests and this guide are excluded. Reproduce the lane-only per-path additions/deletions with:

```bash
git diff --numstat 501ddc27d5520717f7a9e4d9a5b97406ea72022f 6812c46cb3fc0c6f1e10bed92b3f6173d6fdba90 -- automatic-session.ts model.ts square-application.ts square-facade.ts views.ts
```

Physical line/byte totals come from the complete snapshots, not a formatted diff. This lane claims only its own reduction, not storage, catch or status deletions. There is no minification, statement packing, whitespace-only shrink, unrelated comment deletion, excluded-path offloading, new framework or replacement translation DTO.

## Deleted responsibility → remaining owner

| Removed | Owner now |
| --- | --- |
| `model.ActivitiesOptions`, including terminal-only fields and alternate names (`lastN`, `participants`, numeric `after`, `atIndexes`) | Explicit `HistoryQuery` / `HistoryApplicationQuery` compile directly to the existing typed `ActivityFilter` / `SquareRead` boundary in `views.selectHistory`. Effective limit and kind selection are explicit arguments, not another query language. |
| `facadeHistoryOptions` | Cursor parsing, actor resolution, timestamp/context filters and search compilation occur in the selector, without an intermediate object. |
| Independent async `historyPresentation`, async `applicationHistory` orchestration, `HistoryPresentation` | `SquareApplication.history` validates application policy, then constructs final public data and `HistoryProjection` in one artifact read callback. SDK archive calls the selector and public mapping directly; it never builds an application projection or fetches ordinals/anchors. |
| Unused `_name` / `participantHistory` wrapper | The participant handle supplies its default ten and delegates directly to SDK archive. It does not filter the archive to its own name. |
| Native admission's full `entryPresentation` used solely for `joined` | `automaticSessionStart` reads existing `currentParticipant` at the same point. Foreign-binding and unbound-standing refusals, close-before-admission, claim and route ordering are unchanged. |
| Final `HistoryBounds`, exposed `publicBefore` / `publicAfter`, duplicate history `participantCount` | CLI/MCP never consumed these. Selector-local before/after evidence produces the actual continuation. Final projection retains `standingCount`; typed overflow error details remain intact. |

Entry still uses the actual selector with explicit `['say', 'done']` kinds and its effective limit. It retains perception, lifetime say ordinals and join context. No obsolete helper is retained for tests. No schema/storage framing, build validation, catch lease or expression certainty behavior changes.

## Necessary distinctions retained

- **Defaults:** SDK `Square.history` is unbounded. SDK `Participant.history` defaults to ten. Application/CLI/MCP default to ten, cap explicit limits at 100, and reject an implicit merged context larger than 100 with the original `operation.historyBounds` detail. Supplying a limit bounds that context. Application's stricter grep/fixed, non-empty search, finite since and safe nonnegative context validation is unchanged; SDK search remains intentionally looser.
- **Three subsets:** raw selected records can contain reads and historical actorless lifecycle records; public `Activity` omits read/actorless records but retains listen/ignore; ordinary terminal visibility contains join/say/done. Hidden listener events still occupy page positions. Since/context windows still select raw bookkeeping; ordinary history excludes reads. Field formatting uses raw records; CLI JSON now serializes the public SDK result and omits bookkeeping records. No third event model was introduced.
- **Paging:** cursor bounds remain exclusive stable IDs, sparse context counts existing positions, and from/mention/search intersect before applying the limit. An after cursor selects the oldest eligible page; otherwise the newest eligible page is selected. `order` only reverses the selected page. Continuation uses the terminal-visible subset and the same filtered candidate universe; a listener-only page has no invented terminal anchor. Audience paging continues through empty intersections.
- **Projection:** ordinals, presence anchors, roster facts and final data come from the same read callback. The projection clock is now sampled within that callback instead of after the intermediate async presentation completed. It is still an observation-only operation with no receipt, presence or lease writes. Overflow is rejected before unnecessary anchor/ordinal enrichment.
- CLI and MCP require no policy changes: CLI continues formatting raw/terminal records and owner-produced continuation; MCP serializes public data only. Catch's renderer-accessor changes are owned by its separate lane.

## Verification

Repository scripts use the sandbox preload; no live session delivery was exercised.

| Command | Result | Raw local log |
| --- | --- | --- |
| `npm run build && node --import ./test/sandbox-env.js --test test/automatic-session.test.js test/projections.test.js test/core.test.js test/square-facade.test.js test/application-parity.test.js` | 78 pass, 0 fail, 0 skip | `/tmp/history-focused-native.log` |
| `npm test` on merged `3251d02` | 609 tests, 608 pass, 0 fail, 1 skip | `/tmp/history-full-integrated.log` |
| `npm run test:cli-process` on merged `3251d02` | 48 pass, 0 fail, 0 skip | `/tmp/history-process-integrated.log` |

The sole skip is the existing opt-in real Claude runtime test. New focused fixtures exercise sparse read/actorless context, hidden listen/ignore paging positions, before/after continuation, application ordinals/anchors, bounded context rejection with exact structured detail, and unchanged loose SDK search. Native admission's poisoned historical-payload fixture proves the unbound-standing refusal, fresh admission and same-owner resume do not hydrate history; a real SDK history call separately proves the poison rejects when selected. Existing entry hydration/perception, multi-page audience/search, SDK defaults/cursors, application/MCP parity, receipt immutability, CLI continuation and read-window tests remain intact.

The first native regression run used the wrong expected corruption code (`invalid_file`); the real error is `invalid_args`. The fixture assertion was corrected to the actual coded artifact failure plus malformed-row message, then the entire focused command and both final suites passed. No implementation failure or narrowed final suite is hidden.

Retired-symbol search over production and test `.ts`/`.js`/`.mjs` paths (excluding generated `dist` and dependencies) finds no `ActivitiesOptions`, `facadeHistoryOptions`, `historyPresentation`, `HistoryPresentation`, `HistoryBounds`, `participantHistory` or `applicationHistory`. `git diff --check` is clean.

The journal audit/delivery receipts record formal verification and the immutable tender SHA; this guide is not a substitute for those receipts. Independent reviewer `aku/elite/030996ea` owns review; this deliverer does not self-review.
