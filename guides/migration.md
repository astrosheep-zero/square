# Explicit offline artifact migration

Square provides one explicit upgrade edge: a Format12 `.square` artifact to Format13.
Ordinary commands and `Square.at` still accept only Format13. No automatic upgrade,
other artifact conversion, or delivery ledger migration is available.

Stop every process that can write the artifact, including old Square binaries,
before starting. Keep those writers stopped until they have been replaced with
Format13-capable builds. An exclusive SQLite transaction serializes the upgrade;
it cannot prevent an old binary from reconnecting later. Back up the offline
artifact before upgrading if you need to retain a Format12 copy.

```sh
square --location ./example.square migrate
```

`--location` is required and follows the same local path conventions as other
single-square commands. There is no positional path argument. The path must
already exist and end in `.square`; migration never creates a missing artifact.
Success prints the resolved location and `format 12 → 13`. A repeat fully validates
Format13 through a read-only connection and prints `format 13 → 13 (unchanged)`.

The standalone SDK export accepts `SquareLocation` and optional `OperationControl`:

```ts
import { migrateSquare } from '@astrosheep/square';

const result = await migrateSquare(
  { cwd: process.cwd(), path: './example.square' },
  { signal: abortController.signal },
);
// { location: '/absolute/example.square', fromVersion: 12, toVersion: 13, changed: true }
```

An existing Format13 artifact returns `fromVersion: 13`, `toVersion: 13`,
`changed: false` only after complete validation. Unsupported versions, unrelated
SQLite files, malformed schema or logical data, and unsupported journal modes
are refused. The preflight is a read-only SQLite snapshot. A Format12 upgrade
then opens the existing file without creation, acquires `BEGIN EXCLUSIVE`, and
revalidates identity, exact historical schema, integrity and logical rows before
changing anything. The two new tables and `user_version=13` commit together, with
FULL synchronous durability and validation of the result before commit. Failure
or cancellation rolls back; the old tables are never rewritten or replayed.

All existing activities, IDs, times, membership, seats, owners, generations,
attachments, audience, consumption, read receipts, leases, notices, post tokens,
PIDs, export times, posted/full flags, revisions and settings stay intact. Only
`producer_receipt_watermarks` and `producer_departures` are added.

Receipt watermarks start empty. Departure intentions conservatively cover each
captured noncurrent owner/generation/recipient tuple in activity and notice
audiences, plus any surviving nonjoined seat. Both nullable activity audience
identity fields must be present to supply a captured tuple. Consumed, posted,
uncertain and outstanding claimed work all count, regardless of claim age. Exact
current joined seats are excluded, including detached seats. Rejoining a name
does not erase the previous owner's or generation's cleanup intention. These
intentions let normal Format13 reconciliation suppress existing old cards later;
they are not an activity history index or proof of external delivery.

Migration never resolves, reads or opens a host delivery ledger, including CLI
failure recovery. It does not attach sessions, invent receipt evidence, or claim
to preserve Ledger Format3 evidence. The separate Ledger Format4 lifecycle still
requires a fresh compatible ledger; the old `delivery.v3.sqlite` stays untouched.
When a compatible ledger is later used through normal Square operations, receipt
replay starts at watermark zero, and preserved claims follow existing Format13
recovery and suppression semantics. Host attachment remains an explicit host
lifecycle action.
