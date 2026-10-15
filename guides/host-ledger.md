# Host ledger

Square uses one user-level `host-ledger.sqlite` for participant bindings, delivery evidence, and wake attempts. It is separate from every `.square` artifact: the ledger owns host identity, ownership epochs, discovery and delivery evidence; the artifact owns square activity and participant lifecycle.

The default root is `~/.square/host-ledger`. Tests and isolated harnesses may set `SQUARE_HOST_LEDGER_ROOT`; otherwise `SQUARE_REGISTRY` selects its containing directory. An explicit adapter `rootPath` takes precedence. These settings select a single root, not additional ledgers.

## Storage and delivery

SQLite uses DELETE journaling and FULL synchronous writes. Records retain original order and duplicates, with derived lookup indexes and separate presence/evidence revisions. Normal reads of an empty root create nothing. First mutation initializes storage only when neither legacy NDJSON file exists. Legacy-only storage refuses ordinary operation and requires explicit offline conversion; normal operation never dual-reads or automatically migrates.

One wake attempt is one evidence record. Acquisition creates `dispatching` directly, before a send may happen. An interrupted dispatch becomes `unknown`, which forbids redispatch; current token-fenced recovery may still accept a late native admission. Accepted and possibly-sent wake records remain readable at any age. Prepared Claude correlations also bypass age visibility and housekeeping across every outcome, including failed and released, until explicitly retired. Ordinary records retain their existing seven-day visibility horizon, with expired ordinary rows reclaimed only during actual mutations. There is no automatic maintenance GC or activity-id-only sweep; durable delivery evidence is retired only by the explicit, artifact-proven `square ledger gc` below.

## Verify and convert offline

These commands need no participant or square location and use the resolved ledger root:

```bash
square ledger verify
```

Verification is read-only. It checks SQLite identity, version, schema, integrity, record codecs, derived indexes and revisions. With only legacy files, it scans both complete sources and reports accepted, ignored and rejected counts, readiness, and SHA-256 hashes of the original source bytes. Unsafe indexed records make readiness false without hiding the remaining counts or hashes; the CLI reports not ready and exits with status 2. With no files, it reports empty without creating a directory, database or lock. Output never includes record payloads, native credentials or endpoints.

To upgrade an NDJSON ledger:

1. Stop **every** agent session and MCP service using Square with this ledger, including interactive harnesses and background agents. Do not run old and new ones together.
2. Keep a backup of the stopped legacy files.
3. Run:

   ```bash
   square ledger verify
   square ledger migrate
   square ledger verify
   ```

4. Start all hosts with the updated Square version together, using the same root.

Migration does not stop or restart hosts. Its locks fence compatible writers but do not prove hosts are stopped. It acquires the ownership claim fence, then `presence.ndjsonl.lock`, then `evidence.ndjsonl.lock`.

An older SQLite ledger format is upgraded in place by the same `square ledger migrate` under the same stopped-sessions prerequisite and the same lock order. The upgrade preserves every record, duplicate, original order and both observer revisions. `square ledger verify` stays read-only: it reports a supported old format with the migrate command and never upgrades silently. An unsupported format version or an unrelated database is refused with a diagnosis path instead: migration is not a repair command, and a failed migration is never answered by rerunning it blindly.

The importer preserves all ages, future records, duplicates, original order, native correlation and residual fields. It ignores malformed JSON, wrong versions and records without a numeric timestamp, as the old reader did, and reports those counts. Any valid version-1 record whose indexed fields are unsafe refuses the entire conversion rather than losing evidence. Refusal identifies only source kind, rejected count and first rejected line; no accepted subset is published. Legacy unknown wake sources are normalized once during import.

A temporary SQLite database is built and verified under the same root, then published without overwriting an existing destination. Legacy sources remain byte-for-byte untouched. A valid existing SQLite ledger is an idempotent no-op; an older SQLite ledger format is upgraded in place under the fence; invalid or unsupported destinations are refused without repair. There is no force option. On a reported failure, keep hosts stopped, resolve the cause and rerun verification/conversion. An abrupt process termination can leave an unpublished `.host-ledger-migrate-*` directory; after confirming no converter is running, it can be removed without touching the sources or published database.

Once SQLite exists, legacy files are not consulted. Keeping them does not provide a rollback path after new SQLite writes: reverting to them would lose ownership and possibly-sent evidence. For a live SQLite ledger, use SQLite backup facilities rather than copying only its main file.

## Reclaim old evidence

```bash
square ledger gc --dry-run
square ledger gc
```

`gc` considers wake and presentation evidence at least seven days old whose attention is permanently closed, proven per row against the square artifact named in the row: the activity historically reached that participant, and either catch recorded an exact receipt or the participant's later rejoin moved past it. Rows still `dispatching`, lifecycle rows, rows with unusable coordinates and rows whose artifact is missing, invalid or unreadable are retained. Eligibility is a proof, not a promise: `retired` counts rows actually removed, and a row whose record changed after the proof, or whose Claude correlation cannot be retired safely, is retained instead. `--dry-run` proves the same set and changes neither the ledger nor any artifact.

Reclamation is counted in rows, not bytes. Deleted rows free storage for reuse but do not necessarily shrink the SQLite file immediately; `gc` never runs `VACUUM`. Retiring a prepared Claude correlation payload leaves only a permanent `(harness, session, token)` recognition record, without payload, endpoint, location, participant, epoch or timestamp. These records are absent from ordinary evidence and attempts and confer no admission, presentation or receipt authority. Any retired token vetoes the entire native frame, including a mixed live/retired frame. Total token count remains unbounded. There are no hooks, timers or install steps: maintenance runs only when asked.

The obsolete `SQUARE_HOST_LEDGER_USER` and `SQUARE_HOST_LEDGER_LOCAL` settings, project-local fallback and scope-based copying are not used. Older local files and `wake-claims.ndjsonl` remain untouched and are not imported. Bindings that existed only in those abandoned stores require their host to rejoin; do not discard the supported ledger to reset bindings.
