---
id: task/square/preserve-multi-session-route
title: Preserve multi-session route identity
state: done
priority: 1
needs: []
parent: task/square/wake-handoff-p1-remediation
supersedes: []
relates: []
note: Route upsert/publication and HostLedger reconciliation preserve location+participant+session identity; tests cover concurrent Bob sessions.
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T09:46:33.227Z
updatedAt: 2026-08-28T09:53:53.779Z
---
Keep (location, participant, session) as route and presence identity across artifact publication, registry reconciliation, and ledger winner selection. Add regression coverage for two sessions of one participant.