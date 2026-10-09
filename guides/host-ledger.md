# Host Ledger Configuration

Square uses one user-level host ledger for participant bindings, delivery evidence, and wake attempts.

One wake attempt is one `evidence.ndjsonl` row: it carries the attention-wide exclusion for a recipient and activity, and the session-scoped history for that attempt. A row is `claimed` before any send and `dispatching` from the moment a send may happen; a stale `claimed` row is replaceable, while a stale `dispatching` row becomes `unknown` and forbids redispatch. Accepted and possibly-sent wake attempts stay readable at any age, and are eligible for explicit `gcEvidence` removal once their activity is no longer pending. Older Square versions kept a separate `wake-claims.ndjsonl`; that file is no longer read or written, and is left on disk untouched. Running old and new processes against the same ledger at once is unsupported: restart every host process together when upgrading.

The default root is `~/.square/host-ledger`. Tests and isolated harnesses may set `SQUARE_HOST_LEDGER_ROOT`; when it is absent, `SQUARE_REGISTRY` provides the test root. An explicit `rootPath` passed to a ledger adapter takes precedence over both environment defaults.

The old `SQUARE_HOST_LEDGER_USER` and `SQUARE_HOST_LEDGER_LOCAL` settings, project-local `.square/host-ledger` fallback, scope arguments, and reconcile-based copying are removed. Existing local ledger files and directories are left untouched but are no longer read. Bindings that existed only in an old local ledger require the participant to rejoin or restart its host session.

The host ledger remains separate from the `.square` artifact: it owns host identity, ownership epochs, discovery, and delivery evidence. The artifact remains authoritative for square activity and participant lifecycle.
