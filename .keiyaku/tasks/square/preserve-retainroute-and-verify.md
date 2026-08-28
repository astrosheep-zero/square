---
id: task/square/preserve-retainroute-and-verify
title: Preserve retainRoute and verify
state: done
priority: 1
needs:
  - task/square/wire-real-local-and-hook
parent: task/square/local-first-wake-handoff
supersedes: []
relates: []
note: Focused wake/routes/automatic-session/wake-contract tests pass; npm test 238/239 with one pre-existing OpenCode install failure; CLI process retains ten baseline rendering failures; build, rg, and diff check pass.
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T09:16:17.329Z
updatedAt: 2026-08-28T09:36:00.218Z
---
Carry retainRoute through WakeOutcome and run focused/full verification, then tender.