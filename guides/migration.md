# Migrating an existing square

Square stores its authority in one versioned SQLite artifact. Format 1 kept a snapshot;
format 2 introduced typed facts; format 3 added `unlisten`; format 4 moved participant custody
and delivery evidence into the artifact; format 5 added independent delivery deferrals.
**Format 6 separates participant membership from host attachment.** Existing artifacts are
never converted implicitly.

Stop all processes using the artifact, make an offline backup, then run:

```sh
square --location /path/to/SQUARE.square migrate
square --location /path/to/SQUARE.square doctor
```

The command handles supported formats 2–5 in place and publishes only final format 6, in one
transaction. It does not make a backup, stop processes, install a runtime or update another
artifact. For formats 2/3, also freeze and back up the legacy HostLedger used for owner/evidence
import. A legacy ledger needing its own conversion must be prepared separately with its old
runtime's offline tooling. Snapshot format 1 is not accepted by this conversion.

## Membership and attachment after conversion

Membership owns a participant's join/done history, read horizon and outgoing listens. Attachment
says whether its exact Body is currently executing for it. Format 6 makes three endings distinct:

- A participant's voluntary `done` ends membership. A later explicit participant join is required
  to return; no host start/resume revives it.
- Pi shutdown, Codex SessionEnd and Claude session end detach only. No activity lands; membership,
  listens, read horizon, receipts and delivery evidence stay intact. Wake readiness, catch ownership
  and delivery deferrals are cleared. Away participants still receive landed audience and accumulate
  unread activity, but cannot write or receive proactive delivery. Away has no timeout.
- Host-confirmed permanent deletion ends membership through fenced `endOwnedSession`, including
  for a detached seat. OpenCode `session.deleted` uses this path.

On start/resume, hosts discover only their exact Body's standing seats with `bodySeats()` and
restore the detached ones before arming delivery. Same-Body `join`/`implicitJoin` reattaches without
changing the generation, read horizon or listens, so mentions received while away remain unread.
A foreign Body cannot reattach. Explicit takeover still performs `done -> join` with a fresh
generation, even when taking over an away participant; old cleanup/recovery cannot reclaim it.

## Additive conversion from formats 5 and 4

Read-only preflight checks the exact supported framing and stored facts. Format 5 -> 6 adds only
the attachment distinction: **every existing seat becomes attached**. No detached seat is
manufactured. Conversation, audience, receipts, membership, listens, custody generations, catch
ownership, delivery deferrals/evidence, cancellation boundaries and both revision meanings are
preserved. Format 4 also gains empty independent deferral support. Neither conversion consults or
mutates HostLedger. Any failure rolls back the additive changes and format publication together.

Existing done participants stay done. Before format 6, a host-cleanup `done` was indistinguishable
from a voluntary leave; migration conservatively treats both as voluntary. It does not infer
attachment history, reconstruct departures or provide a host recovery path for completed seats.

## Verified import from formats 3 and 2

Formats 2/3 need owner and delivery evidence import. Before writing, migration validates exact
source framing, header and legacy facts read-only. The frozen legacy HostLedger's latest owner
for each participant at this artifact is selected by source `(effectiveAt, seq)` only: no wall
clock, retention, expiry or ownership-history reconstruction is involved.

- A legacy owner Body (`channel`, `session`, optional `agent`) establishes a standing, attached
  seat only when it agrees with all of that name's local route Bodies and the establishing join
  is verified. An owner without routes needs no wake address. Without an owner, one unambiguous
  route Body can establish the seat. An absent agent means the top-level Body; a known agent is
  preserved and compared exactly. Matching repeated registrations are acceptable; wake readiness
  carries forward only when the routes agree. Routes are location-bound: moving an artifact copy
  does not establish that its original routes apply there.
- Without a verifiable owner or route Body, the participant stays standing without custody.
  Membership, history, attention, receipts, landed audience and catch ownership are preserved.
  No Body, route, attachment or departure is guessed. Its name grants no write/delivery authority.
- A Body may own several names; each retains its own generation and wake readiness. Sharing
  does not merge names or choose a winner. Conflicting owner/route Bodies leave that name
  standing without custody; disagreement does not abort conversion. An unverifiable establishing
  join still refuses before publication.
- Evidence structure is validated before placement, including evidence that cannot be imported.
  Malformed facts, activity IDs or native correlation refuse without changing either source.
- Wake/presentation evidence imports only when its Body agrees and it names an existing directed
  say after the verified current join. Missing custody, conflicting session/agent/channel or native
  harness, unknown participants and activity outside the generation cause evidence to be skipped,
  never reassigned to another owner.
- Done participants gain no seat or recovery authority. Only native correlation directly
  attributable to their verified latest join and directed activity before departure is retained
  for retired-token recognition. It authorizes neither admission nor presentation. Ambiguous
  completed-Body mappings, duplicate claim tokens and ambiguous attempt numbering cause all
  affected evidence to be skipped, rather than selecting a winner. A record without an attempt
  number receives attempt 0. Migrated Claude wake addresses retain their native session identity.

This is a narrow, deliberately lossy conversion, not a general history importer. Conversation,
activity IDs, bodies, audience, receipts, source revision meaning and directly verified replay
protection survive. Completed non-native evidence and noncritical metadata—including old presence
history, epochs, diagnostic messages, native observation histories and arbitrary legacy extras—do
not import. Evidence without current or verified completed ownership is skipped and counted. The
read-only legacy ledger remains available for offline diagnosis; an absent ledger permits route-
derived custody, but an unreadable or unsupported ledger refuses before changing the square.

One transaction imports verified authority/evidence, adds deferral and attachment support and
publishes format 6. Existing conversation and membership facts are preserved; no intermediate
format is published. Legacy catch ownership is generation-bound only for exact standing owner
spellings; otherwise it stays unbound. Legacy routes are consumed only during migration and are
not a live authority source. The new delivery revision starts at zero. Format 2 first adds support
for `unlisten`, then follows the same conversion.

The receipt reports recovered seats, unowned standing names, seats sharing a recovered Body,
skipped evidence, and source activity/receipt/catch/route counts. The shared count measures seats,
not distinct Bodies or groups. Skipped includes every legacy wake/presentation record read but
not imported, including completed non-native diagnostics.

## Conservative refusal and retired-token protection

Unrelated databases, unsupported formats, non-`DELETE` journal mode, unknown framing, malformed
headers/facts or native correlation refuse without source changes. Migration is not repair and
never rewrites journal mode to make conversion possible.

For formats 2/3, **any nonempty legacy token-only tombstone collection makes preflight refuse**,
including tokens for other sessions. Those Claude tombstones are replay protection, not diagnostics:
they identify only a session and token, without artifact, participant, activity or join generation.
The converter cannot safely assign them. This is a ledger-wide conservative ambiguity refusal,
not a claim that each token belongs to the artifact being converted. Even a token duplicated by
retained evidence refuses; conversion does not deduplicate or infer history to bypass protection.

Keep the original ledger and artifact intact. Resolve ambiguity offline with replay protection
preserved; **do not delete tombstones just to bypass preflight**. An already-current artifact
returns without consulting the legacy ledger and remains a byte-preserving no-op.

## Before reopening and rollback

Freeze every artifact user and, for formats 2/3, every legacy-ledger writer. Make an offline backup
or use SQLite backup facilities rather than copying a live database. Migration cannot revoke an
in-flight remote delivery. Writes use ordinary SQLite `DELETE` journals: the artifact and its
containing directory must permit writing and journal creation/removal. A legacy ledger needs read
access only. Losing the rebuildable HOME discovery index may delay restoration/delivery but cannot
transfer custody or erase evidence.

Upgrade all attached runtimes before reopening format 6; older runtimes must not be mixed with it.
Updating a package does not migrate an artifact, and migration does not install upgraded runtimes.
After conversion, run read-only `doctor` before restarting clients. To roll back a committed
conversion, stop all clients and restore the offline backup with its compatible older runtime;
do not downgrade the format marker or remove facts in place. Repeating current-format migration
is a byte-preserving no-op.
