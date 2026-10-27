# Migrating an existing square

Square stores its authority in one versioned SQLite artifact. Format 1 kept the
history as one JSON snapshot; format 2 introduced typed rows; format 3 added the
`unlisten` activity; format 4 added artifact-owned participant seats and delivery
evidence; format 5 adds independent expiring delivery deferrals. Existing artifacts are never
converted implicitly.

Use the explicit command while all processes using the artifact are stopped:

```sh
square --location /path/to/SQUARE.square migrate
```

The command handles supported formats 2, 3 and 4 in place and publishes only final format 5.
It does not create a
backup, stop processes, install a runtime, or update another artifact. A legacy
HostLedger that needs its own format conversion must be prepared separately with
the old runtime's offline tooling.

## Format 4 additive conversion

An exact format-4 artifact needs no legacy owner or route import: that authority already lives
inside the artifact. Read-only preflight checks framing and stored facts. One SQLite transaction
adds the empty `delivery_deferrals` table and its owner/generation/expiry lookup index, then
publishes format 5. The dedicated table stores participant key, captured generation, opaque ID,
validated match and expiry, separately from catch leases and delivery evidence. All existing
activities (including metadata), audience, receipts, seats, catch leases, delivery evidence,
cancellation boundaries and both revision values remain unchanged. No lease is manufactured.
The conversion does not consult or mutate HostLedger. Failure rolls back the table, index and
format marker together.

## Format 3 preflight and conversion

Before writing, migration validates the exact format-3 schema, header, and legacy
rows read-only. The configured legacy HostLedger must be frozen along with the
artifact. Its latest owner row for each participant at this artifact is selected
by source `(effectiveAt, seq)` only: no wall clock, retention, expiry, or ownership
history reconstruction is involved.

- A legacy owner Body (`channel`, `session`, optional `agent`) establishes a
  standing seat only when it agrees with all of that name's local route Bodies
  and the establishing last join is verified. An owner without routes needs no
  wake address. Without a legacy owner, one unambiguous Body recorded by that
  participant's own routes establishes its seat instead. An absent agent means
  the top-level body; a known agent is preserved and compared exactly. Repeated
  matching registrations are acceptable; a wake address is carried forward only
  when the routes agree on it. Routes are location-bound: moving an artifact copy
  to another path does not establish that its original routes apply there. An
  off-location copy is not ownership-recovery evidence for the original location.
- Without an owner or any route Body, the participant stays standing without a
  seat. Its source participant state, activities, attention, receipts, landed
  audience and catch lease are preserved. No Body, route or departure is invented;
  the name has no write authority or delivery eligibility. Doctor retains its
  strict history-derived consistency checks.
- A Body may own several participant seats. Each name retains its own seat,
  establishing join generation and wake address; sharing does not merge names or
  choose one name over another. All evidence for each name must agree: if its
  routes disagree with each other or with its legacy owner Body, that name stays
  standing without a seat. Disagreement does not abort migration and neither side
  is chosen as authoritative. Unverifiable joins still refuse before publication.
  Migration does not guess or synthesize authority.
- Evidence structure is validated before placement, including rows that cannot be
  imported. Malformed fields, invalid activity IDs or malformed native correlation
  still refuse without changing either source.
- Wake/presentation evidence for a recovered seat is imported only when its Body
  agrees and it names an existing directed say after the verified current join.
  A missing seat, conflicting session/agent/channel or native harness, unknown
  participant, or activity outside the generation causes the row to be skipped,
  not a failed conversion. Nothing is reassigned to another owner.
- Done participants get **no seat or completed coordinate**. Only native wake
  correlation directly attributable to their verified latest join and a directed
  activity between that join and done is retained for retired-token recognition.
  It does not authorize admission, completion, or presentation. Conflicting
  completed Body mappings, duplicate claim tokens and ambiguous attempt numbering
  cause all affected rows to be skipped, rather than selecting a winner. A single
  record without an attempt number receives attempt 0. Migrated Claude native
  addresses include `sessionId` on both seats and evidence routes.

This is deliberately a narrow, lossy conversion, not a general history importer.
Conversation facts (activity IDs, bodies and audience), receipts and source revision
meaning survive. Replay-critical delivery coordinates, outcomes and native
correlation survive direct mappings. Completed non-native evidence and noncritical
metadata—including old presence history, epochs, diagnostic messages, native
observation histories and arbitrary legacy fields—are not imported. The legacy
ledger is read-only and remains untouched, so it is still available for offline
diagnostics. An absent ledger still permits route-derived seats; an unreadable
or unsupported ledger refuses before changing the square. Evidence without a
current or verified completed owner is skipped and counted. The source ledger is
retained for offline diagnosis; skipped evidence never grants delivery authority.

After successful preflight, one SQLite transaction imports seats and evidence
and adds delivery deferral support, then publishes the current format. All
existing activities, their indices and audience, participant state, attention,
receipts, lease contents, and the source revision are preserved. Legacy routes
are consumed only during migration. Lease generations are resolved only for exact
owner spellings that match a standing participant; other lease rows retain their
legacy, unbound generation. The command reports recovered seats and unowned
standing names, and recovered seats whose Body is shared with another recovered
seat, and skipped evidence rows, alongside the activity, receipt, lease and source
route counts. The shared count measures seats, not distinct Bodies or shared groups.
The skipped count includes every wake/presentation row read from the selected
legacy ledger but not imported, including completed non-native diagnostics.
The new delivery revision starts at zero. There is no intermediate published
format, and any failure before commit rolls back the conversion.

Format 2 first rebuilds only the activity table and its indexes to accept
`unlisten`, then follows the same row-format preflight and conversion. Snapshot
format 1 is not accepted by this migration. Formats 2/3 never publish an intermediate format 4.

## What migration refuses

Migration validates each source's exact row schema. Formats 2/3 include the legacy routes table,
read using migration-local codecs; format 4 already has seats and delivery evidence. Current
format 5 has no routes table or runtime route
reader; migration consumes the old rows only to resolve seats, then drops the legacy
table as part of the format change.

Unrelated databases, unsupported formats, non-`DELETE` journal modes, unknown
schemas, malformed headers, rows or native correlation are refused. The source artifact is preserved on every
refusal. Migration is not a repair command and never rewrites journal mode to make
conversion possible. A HostLedger that itself requires migration must be migrated
separately before Square migration can import its delivery evidence.

## Conservative retired-token restriction

For an old artifact conversion, **any nonempty legacy `host_native_tokens` table
makes preflight refuse**, including tokens for other sessions. Those token-only
Claude tombstones are replay protection, not diagnostics: they contain only a
session and token, with no artifact, participant or activity coordinate. The
converter cannot safely assign them a join generation. This is deliberately a
ledger-wide ambiguity refusal, not a claim that each token belongs to the square
being converted. Even a tombstone duplicated by retained evidence is refused by
this conservative implementation; no deduplication or history inference is done.

Keep the original ledger and artifact intact. Resolve the ambiguity offline with
replay protection preserved; **do not delete tombstones just to bypass preflight**.
An already-current artifact returns without consulting the legacy ledger and
remains a byte-preserving no-op.

## Before and after migration

Stop every session or service using the square, and for formats 2/3 freeze any process writing its
legacy HostLedger. Make an offline backup, or use SQLite's backup facilities rather than
copying a live database. Migration does not revoke an in-flight remote delivery or
modify HostLedger evidence. Square writes use ordinary SQLite `DELETE` journals:
the artifact must be writable and its containing directory must permit journal
creation and removal. The legacy ledger needs read access only. After conversion,
participation and delivery authority live in the artifact, not writable HOME;
loss of the rebuildable HOME discovery index may limit automatic discovery but
does not transfer custody or erase durable delivery evidence.

Upgrade all attached runtimes before reopening the format-5 artifact; older runtimes
must not be mixed with it. Updating a package does not migrate an artifact, and migrating an
artifact does not install upgraded runtimes. For rollback after a committed conversion, stop all
clients and restore the offline backup with its compatible older runtime; do not downgrade the
format marker or drop tables in place. Run the read-only `doctor` command after migration and
before restarting clients. Repeating migration on a current artifact is a
byte-preserving no-op.
