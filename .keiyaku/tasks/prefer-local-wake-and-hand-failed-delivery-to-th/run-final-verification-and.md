---
id: task/prefer-local-wake-and-hand-failed-delivery-to-th/run-final-verification-and
title: Run final verification and tender
state: done
priority: 1
needs:
  - task/prefer-local-wake-and-hand-failed-delivery-to-th/wake-handoff-p1-p2-final-closure
parent: task/prefer-local-wake-and-hand-failed-delivery-to-th/wake-handoff-p1-p2-final-closure
supersedes: []
relates: []
note: "Sequential verification complete: npm run build passed; focused wake/route/registry/hook suite 59/59 passed; npm test 240/241 with only external OpenCode install baseline failure; test:cli-process 23/34 with 11 pre-existing rendering baselines; Contract rg and git diff --check passed. Alice local failed -> privileged hook Bob accepted and second hook made no call."
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T10:11:26.579Z
updatedAt: 2026-08-28T10:30:19.682Z
---
