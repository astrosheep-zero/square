---
id: task/square/unify-wake-state-and-retry
title: Unify wake state and retry policy
state: done
priority: 1
needs: []
parent: task/square/local-first-wake-handoff
supersedes: []
relates: []
note: Removed route freshness retry gate; unknown blocks same-route immediate retry; ambiguous dispatch no longer retries in same invocation. Build passes.
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T08:31:10.512Z
updatedAt: 2026-08-28T08:34:45.455Z
---
Make accepted terminal, unknown non-retryable until recovery, failed retryable by next executor, and remove route.updatedAt retry gating.