# Waiting for changes

Filesystem notifications are hints, not activity delivery or receipts. Artifact revision observation
and reconciliation let catch and stream reconsider changes even if a filesystem event is missed;
subscribers retain independent cancellation and deadlines. Throttling waits for its eligibility time.
There is no discovery index and no daemon or per-message timer.

ACK and export ownership serialize with insertion in producer storage; exact future ACK prevents a
matching late insertion from bypassing it, but cannot recall an already owned export. Cancellation
does not erase history or imply that activity was read. Proactive delivery suppression belongs in the
host delivery ledger; see [delivery-primitives.md](delivery-primitives.md).

At the next normal privileged posting opportunity, already-posted eligible keys can be dispatched
again without reinserting cards or resetting producer state. Ledger attempts exclude accepted, unknown
and presented work; only never-attempted or known-unsent failed/released work can proceed. No new
scheduler or Stop watcher is needed. See [square-api.md](square-api.md) for bounded recovery of
abandoned export ownership.
