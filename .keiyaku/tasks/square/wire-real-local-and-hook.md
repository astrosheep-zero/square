---
id: task/square/wire-real-local-and-hook
title: Wire real local and hook execution
state: done
priority: 1
needs:
  - task/square/move-routes-into-artifact-state
parent: task/square/local-first-wake-handoff
supersedes: []
relates: []
note: Normal activity CLI injects shared wake transport; Codex and Claude hooks invoke processActNotificationsOnce shared delivery path.
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T09:16:08.226Z
updatedAt: 2026-08-28T09:28:44.472Z
---
Connect activity.ts and Codex/Claude hooks to shared deliverPending without detached workers.