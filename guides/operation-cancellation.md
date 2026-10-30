# Operation cancellation

Library operations accept a final non-serializable control value:

```ts
{ signal?: AbortSignal }
```

The signal is checked before lifecycle work and before artifact mutation, and it is propagated through artifact reads, transactions, change waits, and ownership lock acquisition. An idle `catch` rejects promptly when cancelled; it does not wake later and consume activity. Cancellation before an artifact transition prevents mutation.

Commit boundaries are one-way. Once an activity or observation commits, later cancellation cannot
roll it back or turn the result into a retry. A caller may discard the response after the commit,
but the committed activity remains recoverable through `history` or a later `catch`; catch does not
require a second acknowledgement. The separate `pending` query never consumes; its optional
follow-up `ack(ids)` commits exact receipts with the same cancellation boundary.

The single catch lease and independent delivery-deferral leases have distinct lifetimes. Cancelling
an active catch releases only that catch's lease. Cancelling a deferral operation before commit
prevents its mutation; once creation or renewal commits, the lease survives caller cancellation
until explicit release, expiry or retirement of its captured seat. A committed release is likewise
not undone. There is no automatic rollback lease or per-message cancellation timer.

Ownership and delivery have the same limitation: cancellation can stop work that has not entered the boundary, but it cannot withdraw an ownership effect or a transport send that already happened. The returned committed result and existing degradation classification remain authoritative.

Presentation checks cancellation and eligibility before invoking its sink. A rejected sink is not
success, including a native notification whose landing acknowledgement was cancelled. Once the sink
succeeds, recording its evidence and seen receipts is mandatory settlement, not a new cancellable
presentation attempt. It uses the same artifact connection and captured owner/join generation, without
inheriting the pre-effect operation signal or a signal captured when opening that artifact. Claim
release after a cancelled/failed attempt uses the same independent cleanup lifetime and writes no
success receipt. Both settle through the normal authority gate, with a five-second storage budget;
explicit connection close still cancels them. Storage failure is reported, not converted into success.
A batch settles all successfully rendered items before closing its connections, even if one settlement
fails. No settlement reopens a path or grants a replacement seat authority.

The same `Square`/`Participant` methods serve SDK and adapters; see [resource API](square-api.md). Join, listener and lifecycle essential observations use commit-time facts. Join's optional entry enrichment may be unavailable without rejecting its successful receipt. CLI express passes its abort signal through the initial `Square.at`; raw draft saving precedes a separate uncancelled recovery reopen.

Pi notification cancellation is separate and unchanged.
