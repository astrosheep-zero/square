---
id: task/square/route-binding-and-presentation
title: Route binding and presentation through concern projections
state: done
priority: 1
needs:
  - task/square/make-hostledger-the-sole
parent: task/square/decouple-square-activity-from
supersedes: []
relates: []
note: "Session, binding, and presentation projections now serve inbox, presented, Pi, hooks, CLI, wiring, and automatic-session; consumers no longer read registry/ledger private rows. Verification: build exit 0; focused projection/delivery 77/77; diff-check 0; architecture search no forbidden matches; CLI 23/24 with remaining OpenCode install environment failure."
createdBy: codex
createdAt: 2026-08-27T16:28:42.319Z
updatedAt: 2026-08-27T17:54:14.472Z
---
Add session, binding, and presentation projections. Migrate inbox, Pi, hooks, CLI, and presented consumers away from direct registry or ledger-row reads. Keep registry and file modules as adapters only; consumers receive projections rather than private rows.
