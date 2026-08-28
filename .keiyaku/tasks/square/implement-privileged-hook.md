---
id: task/square/implement-privileged-hook
title: Implement privileged hook fallback sweep
state: done
priority: 1
needs:
  - task/square/preserve-multi-session-route
parent: task/square/wake-handoff-p1-remediation
supersedes: []
relates: []
note: Codex and Claude hooks now present session context then run privileged user-index plus cwd artifact sweep through shared deliverPending; regression covers Alice-local failure followed by Alice hook waking Bob.
createdBy: aku/worker-2/550275f2
createdAt: 2026-08-28T09:46:42.708Z
updatedAt: 2026-08-28T10:01:43.518Z
---
Have Codex and Claude privileged hooks discover indexed and cwd-local square artifacts, reconcile them, and invoke shared deliverPending for every eligible recipient. Add Alice-local-failed then Alice-hook wakes Bob regression.