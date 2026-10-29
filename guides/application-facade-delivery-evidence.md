# Shared application boundary: delivery evidence

> **Historical evidence, superseded API.** The factory/outcome shapes and split SDK defaults
> below describe the earlier implementation, not current instructions. Use the real
> [Square/Participant API](square-api.md); the independent factory and its design guide are deleted.


Deliverer evidence, **not independent review or acceptance**. The historical caller/deletion map is recorded below; current ownership is described in [Square/Participant API](square-api.md).

## Candidate coordinates

- Fixed baseline and observed target `main`: `52b58eb9f901f0458302e6120cd83b1079f8ba1c`.
- Production/test implementation commit: `69b0320031b112f220a80180f607c0deb1beeccd` — `Keep raw drafts independent of a failing application clock` (on top of the owner consolidation `8ecf99cd1e7f4eeb5399f1e9de12f5d901250e9c`).
- Measured on 2026-10-15 at 09:23 CST (Beijing time). This evidence is a documentation-only descendant of that implementation. The tender receipt identifies the final candidate; rerun the recipe on that candidate. Documentation does not enter this count.
- No unrelated target changes are included. The seven narrowly amended paths implement captured wake environment, build cancellation propagation, and retired-interface test migration only; no schema/framing/native-protocol changes.

The application factory now returns explicit `{data, projection}` outcomes (except the pull-based stream). This intentionally replaces its old return contract, not the supported SDK resource shapes or MCP wire envelopes. MCP serializes `data`, never the outcome envelope or private projection. SDK handles call shared semantic owners directly, without building application projections.

## Exact committed production count

The Contract recipe was run against the committed implementation, including both new CLI files. Result: **110 production files, 13,934 physical lines, 733,438 bytes; line delta −7**. Bytes increased by 16,488; bytes are reported, not a separate gate. The negative margin is small; no larger reduction is claimed.

Exact recipe (git objects, no checkout edits):

```python
import subprocess
from pathlib import PurePosixPath

BASE = '52b58eb9f901f0458302e6120cd83b1079f8ba1c'
CANDIDATE = 'HEAD'  # Run on the committed integration candidate being reviewed.
EXCLUDED_DIRS = {
    'test', 'tests', '__tests__', 'fixture', 'fixtures', '__fixtures__',
    'script', 'scripts', 'dist', 'build', 'out', 'coverage',
    'vendor', 'vendors', 'node_modules', 'generated',
    'docs', 'doc', 'guides', 'skills', '.agents', '.keiyaku', '.git',
}
EXCLUDED_NAME_PARTS = ('.test.', '.spec.', '.generated.', '.gen.')

def production(name):
    path = PurePosixPath(name)
    return (
        path.suffix in {'.ts', '.js', '.mjs'}
        and not any(part in EXCLUDED_DIRS for part in path.parts[:-1])
        and not any(part in path.name for part in EXCLUDED_NAME_PARTS)
    )

def snapshot(revision):
    names = subprocess.check_output([
        'git', 'ls-tree', '-r', '-z', '--name-only', revision,
    ]).decode().split('\0')
    result = {}
    for name in names:
        if name and production(name):
            body = subprocess.check_output(['git', 'show', f'{revision}:{name}'])
            lines = body.count(b'\n') + int(bool(body) and not body.endswith(b'\n'))
            result[name] = (lines, len(body))
    return result

before = snapshot(BASE)
after = snapshot(CANDIDATE)
for label, data in [('baseline', before), ('candidate', after)]:
    print(label, 'files', len(data), 'lines', sum(v[0] for v in data.values()),
          'bytes', sum(v[1] for v in data.values()))
for name in sorted(before.keys() | after.keys()):
    left = before.get(name, (0, 0))
    right = after.get(name, (0, 0))
    if left != right:
        print(f'{right[0] - left[0]:+7d} lines {right[1] - left[1]:+9d} bytes {name}')
delta = sum(v[0] for v in after.values()) - sum(v[0] for v in before.values())
print('production line delta', delta)
if delta >= 0:
    raise SystemExit('FAIL: production source is not net-negative against the fixed baseline')
```

Exact stdout (including every changed production path):

```text
baseline files 111 lines 13941 bytes 716950
candidate files 110 lines 13934 bytes 733438
   -271 lines    -13402 bytes activity.ts
     +3 lines      +167 bytes artifact.ts
     +0 lines        +5 bytes automatic-session.ts
     +0 lines        +7 bytes catch-decisions.ts
     +0 lines        +5 bytes claude-mod.ts
    +68 lines     +3581 bytes cli/catch-presentation.ts
    -17 lines      -726 bytes cli/context.ts
   +206 lines    +12163 bytes cli/express-presentation.ts
     -1 lines      +114 bytes cli/maintenance-commands.ts
    +10 lines     +1405 bytes cli/observation-commands.ts
     -7 lines       -32 bytes cli/program.ts
   -150 lines     -6582 bytes cli/square-commands.ts
     +3 lines      +181 bytes codex-queue.ts
    -22 lines      -273 bytes decisions.ts
    -21 lines      -511 bytes index.ts
   -103 lines     -3235 bytes list.ts
    -29 lines     -1998 bytes mcp.ts
     +3 lines      +243 bytes model.ts
     +0 lines       +46 bytes notifications.ts
     +0 lines        +5 bytes plugins/opencode/index.ts
    -11 lines      -280 bytes presentation.ts
    +43 lines     +1940 bytes square-actions.ts
   +478 lines    +24632 bytes square-application.ts
   +233 lines    +15186 bytes square-facade.ts
     +1 lines       +83 bytes square-file-adapter.ts
     +0 lines       +60 bytes square-storage.ts
   -136 lines     -6338 bytes square-wiring.ts
    +23 lines     +1407 bytes stream.ts
    +18 lines     +2606 bytes views.ts
     +0 lines       +90 bytes wakes.ts
   -328 lines    -14061 bytes watch.ts
production line delta -7
```

### What actually disappeared

- `square-wiring.ts` (136 lines) is deleted, not a forwarding shim. `Square` and participant resources live with the application owner.
- Root `activity.ts` (271 lines) and `watch.ts` (328 lines) are deleted. Their surviving draft/retry/rendering code is counted in the new CLI helpers (206 + 68 lines); moving renderers is not claimed as semantic deletion.
- CLI build/join/listener/lifecycle/history/status/catch no longer open storage for admission, before/after facts, projections or sweep coordination. `cli/context.ts` no longer constructs a ledger or discovers bindings during parsing. Application `selected` captures an actor per operation, not a mutable-binding cache.
- Catch has one leased quiet-wait owner; the old action absolute-idle loop and CLI heartbeat/revision/finish wrappers are removed. Selection carries records/ordinals/header facts in its receipt transaction. Optional nearby presence does not rehydrate the selected page.
- Express has one preparation/reentry and retry/commit owner. It selects the pending directed feed once, and uses commit-observed count/hold/cap facts rather than rebuilding that feed or issuing a duplicate post-success header query.
- MCP `publicResult`, stored-activity conversion and status-result policy are deleted. Private producers reuse the facade DTOs instead of maintaining parallel status/unread declarations.
- Deleted unused `Square.joinWithActivity`, `takeoverWithActivity`, `joinFacts`, `standingCount`; deleted `views.activityPresentation`, `standingCount`, `joinFacts`, `watchPresentation`, and `presentation.renderWatchOutput`. Focused `recoveryObservation` and optional `catchPresence` replace the displaced mixed queries. Supported SDK/session methods remain.
- `list.ts` no longer parses argv or writes process output; `stream.ts` no longer owns stdout/drain. The CLI owns those adaptations.

No minification, packed orchestration, bulk whitespace/comment deletion, excluded-path offloading, extension changes, vendor/symlink indirection or unrelated production deletion was used. Explicit DTOs, receipt observations, iterator disposal and cancellation propagation account for additions; the semantic removals above must be judged as well as the small negative total.

## Reference and dependency evidence

Reference searches ran over every tracked production path selected by the recipe's `production` predicate. For each pattern, invocation was `subprocess.run(['rg', '-n', '--', pattern, *paths], text=True, capture_output=True)`. Adapter search restricted paths to `cli/**` and `mcp.ts`; contract search used `square-facade.ts`. Exit 1 below means no matches, not a hidden error.

```text
## deleted module imports
pattern: (?:from\s*|import\s*\(\s*)['"][^'"]*(?:square-wiring|/activity|/watch)\.js['"]
(no matches)
rg exit: 1

## retired names
pattern: \b(?:joinWithActivity|takeoverWithActivity|joinFacts|activityPresentation|watchPresentation|renderWatchOutput|cmdListSquares|cmdStreamSquare|publicResult|publicActivity)\b
(no matches)
rg exit: 1

## private action imports
pattern: from\s*['"][^'"]*square-actions\.js['"]
square-application.ts:14:import { catchUp, done, endOwnedSession, express, hold, ignore, implicitJoin, join, takeover, listen, listening, resume, retireEndedSessionRoutes, type ExpressCommittedResult } from './square-actions.js';
rg exit: 0

## adapter direct private execution
pattern: (?:from\s*|import\s*\(\s*)['"][^'"]*(?:square-storage|square-file-adapter|square-actions|views|wakes|notifications|delivery-operations|registry|list|stream)\.js['"]
cli/program.ts:9:import { executeRegisteredCommand, findCommand } from './registry.js';
rg exit: 0

## facade derived contracts
pattern: (?:ReturnType|Awaited)\s*<
(no matches)
rg exit: 1
```

The adapter grep's sole match resolves to **`cli/registry.ts`**, the argv registry, not the root host-binding `registry.ts`. The AST dependency test resolves paths instead of mistaking equal basenames for equal ownership.

`test/architecture-boundary.test.js` passed the transitive adapter/helper traversal and its deliberate hidden-bypass fixtures. It checks all CLI roots, MCP and presentation helpers; permits only named pure bindings (core IDs, immutable held limit, model syntax/errors, identity formatting, search formatting) and closed protocol edges (harness, native hook I/O, MCP immutable `operationEnv`). It rejects private execution hidden through nested helpers, namespace/extra mixed-module bindings, an exceeded native exception and unbounded imports. These are not blanket directory exemptions. Existing storage-boundary/synchronous-capability tests also pass.

## Closure map for pre-delivery findings

These are deliverer closures, not a reviewer verdict. Rows distinguish behavior tests from source inspection; passing a nearby test is not claimed to prove a different edge.

| Finding | Implementation and evidence |
| --- | --- |
| Status loses configured/discovered viewer | Application `status` resolves optional viewer without joining/claiming; `statusPresentation` settles perception. `application-boundary`: configured/discovered status viewer fixture compares directed bodies and unchanged ownership/artifact; `projections`: viewer perception and exact-spelling rejoin annotations. CLI uses that perception, not audience-law fallback. |
| Idle completion fabricates null cursor/zero remaining | `catchOwned.complete` uses committed selection data, or reads authoritative cursor/count only when no selection result exists. `application-boundary`: quiet expiry asserts the existing consumed cursor, including after an actual delivered say; `catch-id`: exact acknowledgement is repeatable and incompatible options do not consume. |
| Stream return hangs behind quiet next | Per-iterator disposal aborts before generator return; observer closes in finally. `application-boundary`: an outstanding quiet pull and `return()` both finish without activity or caller abort. `stream.ts` is pull-based and contains no stdout/drain. |
| Captured clock became loose Number conversion | `clockFor` retains parseInt + finite coded validation; injected clock wins. `application-boundary`: malformed and blank env clock refusal plus injected override. CLI relative-time decoding uses `app.now`. |
| Blank participant env stops discovery | Explicit context still validates; blank env falls through to the injected ledger. `application-boundary`: discovery fixture deliberately supplies `SQUARE_PARTICIPANT_NAME: ''` with a ledger outside the env root. History does not select an actor to choose its limit. |
| Selected/discovered actor lost in errors; generic operation masks express/catch | Named `selected` keeps this attempt's actor and preserves only matching operation detail; inner join enrichment retains canonical committed actor. `application-boundary`: real open failure after explicit/discovered selection proves `express/unsent/Alice`, no mutation. Catch filter/caller distinction has structured refusal assertions. Join actor propagation is also inspected in `selected`/`join`. |
| Actor discovery cached across binding changes | No actor cache. Reused-app fixture joins Alice, leaves, binds Bob, then expresses as current Bob without reentering Alice or claiming a second name. |
| Join count derived by racy pre-read arithmetic | `square-actions.join` returns known joined-or-done count from its authoritative join transaction; takeover returns the same fact from its atomic done+join transaction. `joinOwned` uses returned count, never adds to a pre-read. Verified by transaction/source inspection; existing concurrent-owner/join tests remain passing. Standing headers remain distinct. |
| Express cleanup/enrichment erases commit or calls it unsent | Resource close cannot replace a completed result. Action route/host publication is best effort after commit. Commit observation replaces duplicate post-read. Boundary fixtures prove postcommit host-publication failure returns the activity, projection-clock failure retains landed ID without replay, and selected-row corruption is unknown rather than proven unsent. Operation-cancellation has before-return commit abort coverage. |
| Catch completion/enrichment erases a committed page | Raw page, ordinals/count/cap/hold/terminal facts travel with receipt selection; completion never rereads them. Only optional `catchPresence` can be unavailable. `performance`: real selection hydrates exactly its page; presence/rendering adds no hydration/reads. Operation-cancellation preserves committed consumption after abort. |
| Replaced/cancelled waiter consumes later activity or releases new lease | Catch selection transaction checks lease ID. Finally cleanup is non-aborted and ID-fenced. Boundary fixtures prove replacement owns consumption, old waiter returns replaced, cancelled waiter releases lease, later attention stays pending. Hold/expiry and CLI watch-wait heartbeat fixtures pass. |
| SDK projection roundtrip / leaked observations | The current SDK result shapes are documented in [Square/Participant API](square-api.md); parity tests exercise the real resource and projection tests preserve the detached delivered predicate. |
| Duplicate contracts, aliases and dead mixed views | Private status/unread producers import/re-export facade contracts; catch observation extends shared expression facts and enriched projection reuses it; required express participant replaces name alias. Retired helper search is empty. Recovery selects only gates/bounded unread summaries, not discarded feed/ordinals/perceptions. |
| Packed owner orchestration hides effects/count integrity | History, lifecycle branches, maintenance/discovery/recovery, catch conflict and SDK recognize are expanded into readable steps. Remaining one-line SDK delegates are supported simple resource calls, not packed async policy. Inspect implementation diff; all new source is included in count. |
| Invalid reply / done repair regressions | Typed `invalid_reply` covers malformed and valid-but-absent IDs; typed reach/done reasons stay domain facts, CLI owns glyphs/flags. Express-recovery tests execute printed repaired commands, preserving raw drafts, body candidates and other recipients. Unknown/landed effects offer reconciliation, never replay. |
| Failing application clock prevents draft creation | `executeExpression` uses `saveActivityDraft`'s transport-local `Date.now` default, never the failed owner clock. Focused `express-recovery` fixture supplies a throwing clock and landed error plus throwing recovery; exact CRLF raw is already saved at recovery invocation, landed ID remains in history reconciliation, and no replay is offered. |
| Captured default wake stops at adapter or executable selection | Amended `createDefaultWakeTransport(env)` builds `CodexQueueTransport({env})`; semantic state time belongs to Square operations and never controls external I/O deadlines; queue executable comes from explicit bin, else supplied env, never later ambient env. Boundary test uses a real isolated fake executable and captured child environment/queue destination after global mutation; injected port wins. No real native delivery. |
| Force-build ignores cancellation under lock | Amended build/create signal reaches existing lock retries and transaction boundaries; abort checked before public link, cleanup signal-free, no postcommit rejection. Real exclusive-lock fixture cancels, unlocks, and proves unchanged snapshot/no delayed rebuild/no temporary artifact. Separate published-link fixture aborts after commit and still gets the build result. |
| Removed helper tests / package contract | Obsolete consumers moved to actual application/renderer boundaries, not production stubs. Full suite includes packed ESM root import + TypeScript consumer + unsupported deep-import denial, native import migration, ownership/storage/migration and receipts. |

## Verification on the implemented source

Both declared suites were run serially using repository scripts (sandbox preload), with no live native-session notification or new capacity probe.

| Command | Result | Local raw log |
| --- | --- | --- |
| `npm run test:cli-process` | 48 tests, 48 pass, 0 fail, 0 skip; 33,887.057125 ms | `/tmp/facade-process4.log` |
| `npm test` | 603 tests, 602 pass, 0 fail, 1 skip; 69,523.713167 ms | `/tmp/facade-full5.log` |

The only skipped test is `shipped Claude mod real runtime scheduling and lifecycle`, the existing opt-in real-runtime test. No cancellation, facade, storage or package coverage was skipped. The formal `verified` audit/delivery gate must run or attest both declarations on the final candidate; the journal receipt, not this document, records that attestation.

During integration, stale deleted-helper consumers were migrated to real owner/presentation paths. A captured-env failure and the locked build cancellation gap were fixed under explicit journal amendments. The last failed full run exposed one old core error-text assertion demanding a terminal glyph in domain output; it was updated to the neutral message while keeping requested-name/reason/no-other-name assertions. The full suite passed after that correction. Frozen-source inspection then found the draft timestamp's dependency on a failing owner clock; that dependency was removed and a focused raw-before-recovery/landed-ID regression added. Both suites were rerun successfully as reported above. No failure was hidden by narrowing the final commands.

## Non-claims

- This document does not record independent review or acceptance. The holder/reviewer owns those acts; the deliverer does not self-review.
- Production line reduction does not imply byte reduction or establish architectural quality by itself.
- No artifact replacement support, native protocol redesign, schema change, capacity re-probe or live harness validation is claimed.
