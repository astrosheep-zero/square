# Explicit offline migrations

Square provides two separate explicit upgrade edges: a Format12 `.square` artifact
to Format13, and a Format4 host delivery ledger to Format5. Ordinary opens never
upgrade either file. Other versions remain refused without conversion or deletion.

## Square artifact: Format12 → Format13

Ordinary commands and `Square.at` accept only Format13.

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

Artifact migration never resolves, reads or opens a host delivery ledger, including
CLI failure recovery. It does not attach sessions, invent receipt evidence, or
convert Ledger Format3. When a compatible ledger is later used through normal
Square operations, receipt replay starts at watermark zero, and preserved claims
follow existing Format13 recovery and suppression semantics. Host attachment
remains an explicit host lifecycle action.

## Delivery ledger: Format4 → Format5

Format5 replaces string identities with `DeliveryKey = readonly string[]`. The
location stays `~/.square/delivery.v4.sqlite`; the filename does not select a new
ledger or bypass the explicit cutover. Ordinary `DeliveryLedger.open` refuses an
existing Format4 file read-only. It never migrates it, deletes it, or switches to
a new filename. Ledger Format3 and other versions remain unsupported.

Stop **all** processes writing or reading the ledger, including host delivery
receivers, old Square binaries and external producers. Back up the offline ledger.
Coordinate compatible producer/host releases before migration, then keep old
writers stopped permanently. This is an SDK-only migration; the `square migrate`
CLI continues to operate on `.square` artifacts, not delivery ledgers.

```ts
import { migrateDeliveryLedger } from '@astrosheep/square';
// Also exported by @astrosheep/square/delivery-ledger.

const result = await migrateDeliveryLedger(
  {
    location: '/absolute/path/delivery.v4.sqlite',
    // Producer-owned converters are required for opaque legacy namespaces.
    convertOpaqueKey: legacy => exactMappings.get(legacy),
    convertOpaquePrefix: legacy => prefixMappings.get(legacy),
  },
  { signal },
);
// { location, fromVersion: 4, toVersion: 5, changed: true }
```

Each converter synchronously maps one legacy string to an actual array, or
returns `undefined` to refuse it. Converters run once per distinct opaque exact
key or prefix; their validated results are snapshotted and cached. Strings, sparse
arrays, nonstring segments, asynchronous results and empty exact keys are invalid.
Do not use generic string splitting: only the producer knows its legacy identity
and prefix semantics. Omitted/undefined mappings refuse the entire migration.

The only built-in producer conversion is strict canonical legacy Square keys:
`square:<canonicalAbsolutePath>#act|notice/<index>/recipient/<encodedNameKey>/join/<encodedGeneration>`
becomes `['square', canonicalPath, 'recipient', nameKey, 'join', generation, 'act' | 'notice', String(index)]`.
The complete prefix `square:<canonicalAbsolutePath>#` becomes `['square', canonicalPath]`.
Paths and URI segments must round-trip canonically. Built-in conversion covers only
canonical absolute Square file paths, not historical `memory://` locations. Old
in-memory Square keys and prefixes require explicit opaque converters too; missing
mappings refuse migration without silently deleting their evidence. Malformed
lookalikes, partial or reordered prefixes also require explicit converters and
are never guessed. Any converted prefix must preserve membership of every existing
owner-scoped key and prefix. Converted identity collisions refuse without changing
the source.

Preflight opens the existing file read-only, validates the exact Format4 schema,
header, SQLite integrity and evidence, and converts a snapshot. A missing file is
never created. A single exclusive transaction revalidates that unchanged source,
rebuilds the key-bearing tables collision-safely, updates the format and validates
Format5 before committing with FULL durability. Cancellation or failure rolls back
all changes. An existing Format5 is fully validated read-only and returns
`{location, fromVersion: 5, toVersion: 5, changed: false}` without writing.

Migration preserves sequence counters, card sequences/text/details/timestamps,
sessions/generations/routes/states, attempts/tokens/correlation/custody, receipt
sequences/times, suppression ids/scopes/creation/expiry, and cancellation cutoffs.
It does not normalize, garbage-collect, send, acknowledge, attach or infer that an
uncertain card was presented. Already expired rows remain evidence during migration.

### Coordinated external producer prerequisite

The external `/Users/astrosheep/Developer/keiyaku-v4/plugins/square/index.ts`
currently posts `keiyaku/${akumaId}/${ref}`, suppresses exact outcomes, and holds
`keiyaku/${id}/turn/` with renew/release. Its corresponding array-key producer and
explicit exact/prefix converters must ship in coordination **before any real
ledger cutover**. Square does not infer that namespace and this foundation does
not modify that repository. Do not migrate a real ledger until every producer and
host is ready; otherwise preserved custody could be orphaned or notifications
resent under different identities.
