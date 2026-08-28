---
id: task/square/move-routes-into-artifact-state
title: Move routes into artifact state
state: done
priority: 1
needs: []
parent: task/square/local-first-wake-handoff
supersedes: []
relates: []
note: Receiver-owned routes persisted in SquareState artifact; route reads no longer use user registry.
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T09:16:07.891Z
updatedAt: 2026-08-28T09:27:57.618Z
---
Add receiver-owned route declarations to SquareState/artifact and ensure provider-native route publication with Paseo preference.