# Migrating an existing square

Square stores authority in one versioned SQLite artifact. Version 1 kept the
whole history as one JSON snapshot. Version 2 introduced typed rows. Current
format 3 adds the `unlisten` history event without changing the other tables.

Existing artifacts are **not** converted automatically. Ordinary reads and
writes refuse versions 1 and 2 with an offline-migration requirement. The CLI
adds the concrete recovery command; native tools retain the description:

```sh
square --location /path/to/SQUARE.square migrate
```

This is the only artifact migration command. There is no `--check`, `--backup`,
`--force`, bulk mode, sidecar, daemon or dual reader. The host ledger is a
separate resource; unlisten does not change its format.

## What the command does

Both supported conversions happen **in place**, in **one transaction**:

1. Read the owned framing before any persistent pragma or DDL: application id,
   source format, `DELETE` journal mode, and exact known schema.
2. Take `BEGIN IMMEDIATE` and re-check that framing under the lock.
3. Convert the source using its explicit path:
   - **Version 1:** decode and validate the complete snapshot, create current
     rows, and preserve activity indices/gaps, optional fields, raw receipt and
     lease owners, ordered routes, strings and finite fractional timestamps.
     Rebuild derived participant, hold, attention and landed-audience facts
     with the runtime's shared landing transition, then drop the snapshot.
   - **Version 2:** rebuild only `activities` and its indexes to accept
     `unlisten`, copying every existing activity row unchanged. All other
     tables, including attention, landed audience, receipts, leases, routes
     and configuration, remain untouched. No history is reinterpreted.
4. Set format 3 and commit once.

Revision and assigned activity indices are preserved. Migration adds no domain
activity. Nothing is published piecemeal, and path, inode and registry identity
remain unchanged. A format-3 artifact is reported as already current without
writing, including when another migrator finished while this one waited.

## What it refuses

Missing files, unrelated databases, unsupported versions, different journal
modes, unknown schemas and malformed headers are refused without a write.
Version-1 snapshot JSON and activity vocabulary must be valid for that source
format. Non-finite numbers anywhere in a legacy route, including nested extra
properties, are refused with the offending property named; they are not
silently coerced to null. Journal mode is never rewritten to make conversion
possible, and migration is not a corruption-repair command.

## Before you migrate

Stop every session and service using that artifact. Make an offline backup, or
use SQLite's backup facilities rather than copying a live database. The command
does not manage backups, stop processes, revoke in-flight remote deliveries,
or update installed runtimes.

Upgrade all attached runtimes before reopening the migrated artifact. Both
version-1 and version-2 runtimes refuse format 3; do not mix old and new
processes against the converted file. An older writer either commits before
conversion or meets the new version gate afterwards.

## Crash safety and checking

Before `COMMIT`, SQLite's journal recovers the complete source version; after
it, complete format-3 rows are present. A failure or process death cannot leave
a partial conversion. A busy `COMMIT` retries the same transaction, never the
copy or domain callback.

`square --location <path> doctor` is read-only. On versions 1 and 2 it prints
the migration requirement without calling the artifact damaged. On current
format 3 it validates rows and recomputes derived indices for comparison.
Run it after migration and before restarting upgraded clients.
