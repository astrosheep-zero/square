---
id: task/square/reduce-notifications-to-an
title: Reduce notifications to an executor adapter
state: done
priority: 1
needs:
  - task/square/make-hostledger-the-sole
parent: task/square/decouple-square-activity-from
supersedes: []
relates: []
note: "notifications now only assembles transport adapters and forwards deliverPending and the pending sweep. Verification: build exit 0; notifications 8/8; delivery operations 5/5; delivery-e2e 13/13; wake-attempts 5/5; delivery-health 1/1; sweep performance 1/1; diff-check 0."
createdBy: codex
createdAt: 2026-08-27T16:28:42.319Z
updatedAt: 2026-08-27T17:25:07.742Z
---
After the evidence owner converges, make notifications only assemble concrete transport adapters, call deliverPending, and return results. Remove lease, attempt, route, and eligibility policy branches from processActNotificationsOnce and sweepPendingNotifications; delete obsolete entry names or leave only zero-decision forwarding shells.
