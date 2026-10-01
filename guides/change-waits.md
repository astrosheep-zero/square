# Waiting for changes

Square's artifact and host-ledger adapters own change detection. Notifications are hints, not activity delivery or consumption receipts.

- A process shares a revision reader per canonical artifact and a filesystem watcher per containing directory. Subscribers have independent baselines, deadlines, and cancellation. The final release closes the watcher, reconciliation timer, and any outstanding read.
- Directory notifications invalidate lightweight reads. A two-second reconciliation checks revisions/ledger metadata even when notifications are missing. Missing directories, unsupported watches, and watcher failures retain that fallback; directory replacement is detected during reconciliation. Normal notification latency is not a hard guarantee: a missed hint may wait for reconciliation, plus scheduling and lock contention.
- The artifact revision remains authoritative. No new sidecar, broker, or persistent cache is introduced. Only changed projections load historical state. Ledger metadata invalidates bindings and presentation projections; it is never treated as evidence of delivery.
- Each Pi session owns a long-lived pending observer, including when it has no bindings yet. Presence and evidence changes update its subscriptions. There is no repeated thirty-second restart and no per-second binding scan. A failed injection waits for a substantive change; its own failed evidence write does not trigger a retry loop.
- Blocking CLI catch waits for a revision or its next heartbeat/quiet deadline. A held catch keeps its lease alive and pauses quiet expiry. Core catch, NDJSON stream, and delivery-receipt waits use the same change detector. Held express also waits for changes; throttling still waits for its eligibility time.
- Catch lease expiry, ledger retention/claim expiry, and cancellation are independent wake conditions. No filesystem write is required for a time-based eligibility change.
- Existing catch filters, lease priority, presentation claims, full-delivery seen receipts, clipped previews, and session-local cancellation suppression remain in force. Sharing storage detection does not share session delivery state. Cancellation never creates a receipt or removes history.

## Verification

Run all tests with the sandbox import; never attach synthetic participants to a live harness identity.

```sh
npm test
npm run test:cli-process
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 100 --mode poll200
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 100 --mode events
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 100 --mode session
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 100 --mode session --active
```

The benchmark creates disposable synthetic history. poll200 reconstructs the preceding lightweight 200ms polling strategy; events measures revision waits. session includes binding and notification projection, but excludes initial setup. Active runs inject one bell and report committed-write-to-projection latency, not native Pi message landing. They allow up to twenty seconds so saturation is distinguishable from a lost wake. One hundred processes still have one hundred monitors: sharing is process-local, not a claim of cross-process deduplication.

A long-running Pi process must reload/restart its Square extension to use rebuilt code.
