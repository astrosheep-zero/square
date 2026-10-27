# Waiting for changes

Artifact revisions and the rebuildable discovery index drive change detection. Filesystem
notifications are hints, not activity delivery or consumption receipts.

- A process shares a revision reader per canonical artifact and a filesystem watcher per containing
  directory. Subscribers have independent baselines, deadlines and cancellation. The final release
  closes the watcher, reconciliation timer and outstanding read.
- Directory notifications invalidate lightweight reads. A two-second reconciliation checks revisions
  even when notifications are missing. Missing directories, unsupported watches, watcher failures
  and directory replacement retain that fallback. Latency is not a hard guarantee: a missed hint
  may wait for reconciliation, scheduling and lock contention.
- Conversation revision controls the pending-content cache. Delivery revision separately invalidates
  eligibility, including delivery evidence, cancellation and deferral writes. Projections resolve
  current typed seats and selected bodies in one coherent artifact read; they never grant authority
  from an index entry or a cached eligibility decision. No sidecar, broker or second delivery store
  is introduced. An unreadable candidate cannot authorize cached content.
- Each active session pending observer subscribes before selecting current candidates and facts,
  including when no seat is yet discoverable. Index publication can wake discovery without an
  artifact write. A failed injection waits for substantive change; its own failed evidence write
  does not cause a retry loop.
- Deferral create/renew/release and opportunistic pruning change delivery revision, not conversation
  activity. Release rechecks eligibility without a new message. Expiry needs no synthetic write:
  the observer includes the earliest relevant matching live deferral expiry in its existing wait
  deadline, alongside catch-lease expiry/staleness. Overlapping leases remain OR; an early expiry
  rechecks the remaining live leases. Renewal changes that deadline without self-triggered delivery.
- There is no new daemon or detached per-message timer. A one-shot producer skips deferred work and
  returns promptly. An existing active delivery observer will reconsider release/expiry; absent an
  observer, pending work waits for the next normal delivery opportunity. A lease does not create a
  process that was not already running.
- Blocking catch waits for conversation revision or its heartbeat/quiet deadline. A held catch keeps
  its single lease alive and pauses quiet expiry. Core catch and streams use the same storage change
  detector. Held express also waits for changes; throttling waits for its eligibility time.
- Deferrals are independent of catch filters, presentation claims, full-delivery seen receipts,
  clipped previews and session-local cancellation. Sharing storage detection does not share session
  delivery state. Cancellation never creates a receipt or removes archive history. A deferral cannot
  recall a send already past its final freshness check.

## Verification

Run all tests with the sandbox import; never attach synthetic participants to a live harness identity.

```sh
npm test
npm run test:cli-process
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 100 --mode poll200
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 100 --mode events
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```

The benchmark creates disposable synthetic history. Process-local sharing does not deduplicate
monitors across processes. Timings measure committed-write-to-projection latency, not native
message landing, and discovery deadlines are probe bounds rather than an SLA. Historical benchmark
evidence may describe older HostLedger implementations; it is not current custody authority.
A long-running extension must reload upgraded code before using the new artifact format; this
delivery does not install or restart one.
