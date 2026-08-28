---
id: task/square/verify-and-clean-wake-handoff
title: Verify and clean wake handoff
state: done
priority: 1
needs:
  - task/square/connect-local-and-privileged
parent: task/square/local-first-wake-handoff
supersedes: []
relates: []
note: "Completed implementation and cleanup. Verification: npm run build passed; delivery-e2e passed 4/4; Contract rg and git diff --check passed. npm test remained 237/239 with unrelated environment failures: test/codex-queue.test.js:83 Codex temp script ETIMEDOUT, test/square-cli.test.js:107 OpenCode external install failed. npm run test:cli-process remained 24/34 with 10 unrelated pre-existing CLI rendering/time baseline failures: status renders hold duration from real actor; catch --from renders named peers and rejects removed --by; history --since excludes older public activity; ambient catch/history body perception; bare say presence rendering; bell quota refusal; status attention/stable ids; room changes/final notes; status attention/express blocker; unread join alone. No failure touched the wake diff."
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T08:31:33.677Z
updatedAt: 2026-08-28T09:06:05.093Z
---
Run build, tests, CLI process tests, architecture search, add focused regressions, and remove stale worker or freshness references.