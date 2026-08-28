---
id: task/square/connect-local-and-privileged
title: Connect local and privileged delivery
state: done
priority: 1
needs:
  - task/square/unify-wake-state-and-retry
parent: task/square/local-first-wake-handoff
supersedes: []
relates: []
note: Added capability probe before shared lease, local post-commit delivery injection through Square/OpenSquare, shared deliverPending path, and Paseo-preferred route publication.
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T08:31:21.097Z
updatedAt: 2026-08-28T08:38:04.496Z
---
Use one deliverPending path for capable local post-commit wake and privileged hook fallback, with capability probing and shared lease/evidence.