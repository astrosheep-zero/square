---
id: task/square/separate-presentation-sink
title: Separate presentation sink capability
state: done
priority: 1
needs:
  - task/square/make-hostledger-the-sole
parent: task/square/decouple-square-activity-from
supersedes: []
relates: []
note: "Defined and wired independent PresentationSinkPort.present(activity); presentPending remains separate from deliverPending and WakeTransport. Verification: 60/60 focused presentation/delivery/hook/Pi/e2e/automatic tests, build exit 0, diff-check 0."
createdBy: codex
createdAt: 2026-08-27T16:28:42.319Z
updatedAt: 2026-08-27T18:01:40.320Z
---
Define a small PresentationSinkPort distinct from WakeTransportPort. Keep presentPending separate from deliverPending because artifact seen is presentation authority while wake remains awareness-only. Preserve clipped and unknown retry semantics and session/capability claim isolation.