---
id: task/square/verify-and-remove-legacy
title: Verify and remove legacy executor coupling
state: done
priority: 1
needs:
  - task/square/separate-presentation-sink
parent: task/square/decouple-square-activity-from
supersedes: []
relates: []
note: "Legacy production coupling cleared: presentOnce/recordPresentedForOwner, wake claim helpers, no-op wake bridge, notifications duplicate evidence reads removed; wake-evidence/wake-attempts remain thin forwarding adapters only. Verification: build exit 0; core focused 23/23 and final related broad 77/78 with one intermittent Claude cross-file race while full npm test exercised that test successfully; diff-check 0; legacy architecture search clean. Full npm test remains 228 pass/8 baseline/environment failures (artifact notifyLeases schema fixtures, registry lifecycle expectations, Codex timeout, OpenCode install timeout); CLI process remains baseline rendering/time failures."
createdBy: codex
createdAt: 2026-08-27T16:28:42.319Z
updatedAt: 2026-08-27T18:48:32.768Z
---
Run focused tests, build, diff-check, npm test, and npm run test:cli-process. Remove obsolete direct imports, worker launch vocabulary, duplicate evidence readers, and stale tests. Require zero Contract-specific regressions and an architecture grep showing only adapters know ledger storage details.