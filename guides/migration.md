# Migrating an existing square to row storage

Square stores authority in one versioned SQLite artifact. Version 1 kept the
whole history as one JSON snapshot; version 2 keeps typed rows — activities,
sparse receipts, catch leases, ordered routes and the small configuration
facts — in one in-place database.

Existing artifacts are **not** converted automatically. A normal read of a
version 1 artifact refuses with a descriptive offline-migration requirement.
The CLI adds the concrete recovery command; native tools retain the description:

```sh
square --location /path/to/SQUARE.square migrate
```

That is the only migration command. There is no `--check`, `--backup`,
`--force`, bulk mode, sidecar, daemon or dual reader, and no operator
configuration to set.

## What the command does

It converts the artifact **in place**, in **one transaction**:

1. Reads the owned legacy framing before touching anything (application id,
   format version, `DELETE` journal mode, the exact snapshot schema) and
   refuses anything that is not an owned version 1 square.
2. Takes `BEGIN IMMEDIATE`, re-checks that framing under the lock, and decodes
   and validates the complete snapshot inside the lock.
3. Creates the row schema and writes the preserved authority: activity indices
   and their gaps, optional-field presence, raw receipt and lease owner keys,
   route order and duplicates, string content and finite fractional timestamps.
4. Rebuilds the derived participant, hold, attention and landed-audience facts
   through the same single landing transition the runtime uses.
5. Drops the snapshot table, sets the format version, and commits once.

The revision is preserved; migration never invents or advances it. Nothing is
published piecemeal, and the file keeps its path, inode and registry identity.

Two shapes are already fine and change nothing:

- an artifact that is already version 2 (reported as already format 2);
- an artifact converted by another process while this one waited for the lock.

## What it refuses

Nothing is written when the input is not a normally persisted version 1 square:
a missing file, an unrelated SQLite database, an unsupported format version, a
different journal mode, an unknown snapshot schema, unreadable snapshot JSON, or
a route carrying a non-finite number (an exponent-overflow value such as
`1e999`, which the previous permissive check accepted and an ordinary JSON round
trip cannot carry) are all refused before any write. The refusal names the
offending route property.

Journal mode is never rewritten to make a migration possible.

## Before you migrate

- Stop attached runtimes, or upgrade them together with the migration. An
  in-flight remote delivery is not revoked by migration, and a version 1 writer
  either commits before the conversion or is refused afterwards — it can never
  overwrite converted rows.
- An offline backup is optional and, if you want one, ordinary: copy the file
  while no writer is attached. The command does not manage backups.

## Crash safety

Before `COMMIT`, SQLite's own journal recovers the complete version 1 artifact;
after it, the complete version 2 rows are there. A process killed mid-migration
therefore leaves one or the other, never a partial artifact, and re-running the
command finishes the job. A busy `COMMIT` retries the same transaction and never
re-runs the conversion.

## Checking an artifact

`square --location <path> doctor` is read-only. On a legacy artifact it
recognizes version 1 and prints the migration command; it does not call the
artifact damaged. On version 2 it validates the rows and recomputes the derived
indices to compare them against the stored ones.
