---
id: task/square/move-producer-presence-after
title: Move producer presence after artifact commit
state: done
priority: 1
needs: []
parent: task/square/decouple-square-activity-from
supersedes: []
relates: []
note: Faye ruling implemented and focused regression passed; producer activity commits before best-effort repo-local presence.
createdBy: codex
createdAt: 2026-08-27T16:28:42.319Z
updatedAt: 2026-08-27T16:29:53.300Z
---
Apply Faye ruling: join, implicitJoin, express, and catch must commit SquareState first, then best-effort write only repository-local presence. Host-ledger failure must never reject an already committed activity. User-scope presence remains owned by reconcileBinding. Add crash and permission regression coverage.