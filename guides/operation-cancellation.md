# Operation cancellation

Library operations accept a final non-serializable control value:

```ts
{ signal?: AbortSignal }
```

The signal is checked before lifecycle work and before artifact mutation, and it is propagated through artifact reads, transactions, change waits, and ownership lock acquisition. An idle `catch` rejects promptly when cancelled; it does not wake later and consume activity. Cancellation before an artifact transition prevents mutation.

Commit boundaries are one-way. Once an activity or observation commits, later cancellation cannot roll it back or turn the result into a retry. A caller may discard the response after the commit, but the committed activity remains recoverable through `history` or a later `catch`; Square does not add a second consumption acknowledgement phase.

The single-root HostLedgerPort passes `(input, signal)` for cancellable claims; cancellation does not create a second storage scope.

Ownership and delivery have the same limitation: cancellation can stop work that has not entered the boundary, but it cannot withdraw an ownership effect or a transport send that already happened. The returned committed result and existing degradation classification remain authoritative.

Pi notification cancellation is separate and unchanged.
