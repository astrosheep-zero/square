# Pi pending content reuse

Pi observes pending notifications before presenting them. The presentation lookup now calls `SessionPendingObserver.read()` to reuse the observer's content projection when the committed artifact revision and current session binding still match.

`wait()` and `read()` have distinct jobs: waiting subscribes to filesystem hints and expiry; reading checks the database's revision directly. Both share membership hydration, lease expiry handling and live presentation-evidence filtering. A delayed filesystem hint can therefore delay a wake, but cannot authorize stale content at the presentation boundary. An unreadable current revision never falls back to cached membership.

`read()` does not create or retire watchers. It borrows the existing content cache when present and reads normally for newly discovered memberships. No authorization is reused from the cache; current bindings, live evidence and existing presentation checks still run. Existing presentation claims, pending checks, receipt transactions and cancellation remain in place.

## Verification

`test/pi-pending-cache.test.js` counts the artifact's recipient-projection queries from Pi session start to its first send. With one pending mention and one bound participant, the unchanged projection is hydrated once; a fresh `sessionInbox` call demonstrates the eliminated second hydration. This is a content-read count, not a promise of lower wall-clock latency: the boundary still pays for an authoritative revision read and live eligibility checks.

A second test suppresses filesystem hints and periodic reconciliation, warms the old version, then commits a catch lease. It proves the hint cache is still stale while `read()` observes the lease and yields the notification. Removing the lease restores eligibility without a hint. Existing observer and Pi lifecycle tests cover binding changes, lease expiry, unreadable artifacts, failed delivery and cancellation.
