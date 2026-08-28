---
id: task/square/make-hostledger-the-sole
title: Make HostLedger the sole evidence owner
state: done
priority: 1
needs:
  - task/square/move-producer-presence-after
parent: task/square/decouple-square-activity-from
supersedes: []
relates: []
note: "HostLedger owns presence/route/lease/attempt/wake evidence; wake-attempts is a zero-decision adapter. Worker verification: npm run build, focused 23/23, git diff --check; crash recovery has no residual dispatching claim."
createdBy: codex
createdAt: 2026-08-27T16:28:42.319Z
updatedAt: 2026-08-27T17:06:04.335Z
---
Move presence, route, lease, attempt, wake evidence, and presentation evidence row ownership into HostLedgerPort and its adapter. Eligibility, terminal, and retry decisions remain pure domain logic over port results. Remove wake-attempts and wake-evidence storage/decision bypasses; retain no compatibility ballast.
