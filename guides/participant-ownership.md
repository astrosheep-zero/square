# Participant Ownership

This document defines the ownership boundary for a participant name, a host
session, and its wake route. It is the contract for ordinary `join`, automatic
session startup, explicit `--kick`, and session shutdown.

The central invariant is simple:

> At most one live host session owns a participant name in one square.

An artifact participant and a host session are related, but they are not the
same fact. The artifact is authoritative for the participant lifecycle. The
host ledger is authoritative for the local session binding. A wake route is
only a callable address for an existing binding.

The uniqueness key is the canonical square location plus `nameKey(name)` (the
same normalized identity used by the artifact). Display spelling does not
create a second participant.

## Owners

| Fact | Authority | May change it |
| --- | --- | --- |
| Participant name is known, active, or done | Square artifact (`SquareState`) | Square actions in an artifact transaction |
| Session owns a name at a location | Host ledger presence | Registry/ledger binding operations |
| Session can be woken | Wake route in the square artifact | Route operations after the lifecycle commit |
| CLI or hook requested join, kick, or shutdown | CLI or host adapter input | The caller only; it does not become a new authority |

No layer may use display text, a route row, or an old registry row as a
replacement for the authoritative fact it does not own.

## Call Boundaries

The artifact boundary and the host boundary exchange facts, not each other's
storage objects:

- `square-core` and participant lifecycle actions decide and commit activities
  (`join`, `done`, takeover) and artifact-owned wake routes. Their post-commit
  presence refresh is best effort; they do not discover foreign sessions,
  claim names, or remove another session's presence.
- The host ledger claims and releases `(location, name, session, channel)`
  bindings. It does not append participant activities and it does not decide
  whether a name is active in the artifact.
- The name claim must be an atomic compare-and-set on `(location, name)`:
  observe-then-upsert (`listPresence` followed by `ensurePresence`) is not a
  claim and cannot enforce the one-owner invariant under concurrency.
- CLI and hook orchestration obtains the current session identity, sequences
  the two boundaries, and performs exact-session cleanup. It may pass a
  participant name and a lifecycle intent to an artifact operation; it must
  not pass host binding rows or `oldSessionIds` into a square action.
- Route publication and retirement write the artifact route set. A route is
  useful only while its exact session binding is owned; route rows are not a
  second name-ownership ledger.

The intended shape is therefore `claim/verify -> artifact transaction ->
presence/route effects`. A helper that combines those steps is an orchestration
helper, not a square action. In particular, a `takeover(name,
oldSessionIds)`-style API is the wrong boundary: the artifact can retire the
active participant routes by name, while the host adapter cleans old presence
by the exact sessions it observed.

## Ordinary Join

`join` is a name claim, not a reconnect heuristic.

1. Validate the requested participant name.
2. Ask the host ledger to claim the `(location, name)` binding for the current
   session. An existing binding for another session is a hard refusal. A
   binding that this same session already held is an idempotent reconnect. A
   newly-created claim is provisional until the artifact check below passes.
3. In one artifact transaction, decide and commit the participant `join`
   activity when the name is not active. If the artifact already says that the
   name is active, only a pre-existing binding for this exact session may
   reconnect; release a provisional claim and refuse every other caller.
4. After the artifact commit, ensure presence for the current session only.
5. After presence is established, publish the current session's primary wake
   route.
6. Render the entry result from the committed artifact snapshot. Rendering
   does not perform another ownership decision.

If any precondition fails, no join activity, presence row, or route is created
left behind for the refused session. A reconnect does not append another `join`
activity.

## Automatic Session Startup

Automatic startup is a host adapter around the same ownership semantics. It is
not an implicit kick and it does not get a separate exception for configured
names.

1. Derive the participant name from the provider session and environment.
2. Attempt the host-ledger binding claim.
3. If another session owns the name, return the coded `already_joined`
   refusal. Do not rewrite the artifact, remove the other session, or create a
   second binding.
4. If the current session already owns the binding, refresh its presence and
   route without another artifact `join`.
5. If the name is new, commit the single artifact `join`, then establish
   presence and route as in ordinary join.

The hook boundary catches and reports this refusal according to host policy;
the hook must not silently turn it into a takeover.

## Explicit Kick

`join --kick` is the only name-takeover operation. It is an explicit human
action and must leave an observable lifecycle, not merely overwrite a ledger
row.

1. Resolve the requested name and collect the currently active bindings for
   that name. The current session is excluded from the old-owner set only when
   it is already the owner and this is a reconnect, not a kick.
2. Under the artifact lock, commit two lifecycle activities as one transaction:
   `done` for the standing participant, followed immediately by `join` for the
   reclaimed name. If this transaction cannot commit, nothing is kicked.
3. In the same artifact transaction, remove every route for the kicked
   participant. The artifact operation receives only the participant name; it
   does not receive host session rows. The new route is not published until
   after the transaction succeeds.
4. After the artifact commit, remove every old owner's presence from both
   readable ledger scopes. The cleanup is keyed by the exact old session and
   channel; never remove by participant name alone.
5. Establish the new session's presence and publish its route.
6. Reconcile once from the committed artifact and ledger facts. Reconciliation
   may remove stale external rows, but it may not invent a join or undo the
   committed takeover.

The resulting history must contain `join -> done -> join`. A successful kick
must leave no old binding and no old callable route. If external cleanup is
temporarily unavailable, the artifact still records the kick and the cleanup
remains retryable and session-scoped.

## Session Shutdown

Session shutdown is owner-scoped.

1. Look up the binding by the exact session id and square location in the host
   ledger.
2. If no binding exists, stop without changing the artifact.
3. If the binding exists and its participant is still active, ask the artifact
   boundary to commit that participant's `done` activity. The artifact action
   does not need the session id.
4. Remove that exact session's presence in the host ledger and retire that
   exact session's route in the artifact.
5. Do not mark a replacement session done, even when it uses the same display
   name. Under the invariant, such a replacement should have been rejected or
   created through `--kick`.

A shutdown arriving after a kick is an idempotent cleanup of an already-removed
owner. It must not append a second `done` for the new owner.

## Concurrency and Recovery

The artifact transaction serializes participant lifecycle activities. The host
ledger lock serializes binding rows. These locks protect different facts and
must not be replaced with a copied sidecar or a display-level mutex.

The safe ordering is:

1. Claim or verify the session binding.
2. Check the artifact state and commit its lifecycle transaction.
3. Apply presence and route effects for the committed result.
4. Retry or reconcile only the external effects that did not commit.

An operation must never claim success from a partially completed sequence. A
failed precondition produces no artifact mutation. A post-commit ledger or
route failure produces a diagnosed, retryable external inconsistency while
preserving the artifact's committed lifecycle.

## Acceptance Evidence

The implementation is complete only when these invariants are directly tested:

- two sessions cannot concurrently own the same `(location, name)`;
- same-session reconnect is idempotent and appends no second `join`;
- automatic startup refuses a foreign owner and never performs a kick;
- `join --kick` records `done -> join` atomically;
- kick cleanup removes old presence and routes by exact session identity;
- a kicked session's later shutdown cannot close the replacement;
- a failed external cleanup is retryable without duplicating lifecycle
  activities;
- reconciliation removes stale external rows only when the artifact proves
  the participant is no longer active.

Tests should assert the authoritative facts and their ownership boundaries,
not the order of helper calls or the wording of CLI output.
