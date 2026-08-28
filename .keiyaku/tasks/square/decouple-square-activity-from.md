---
id: task/square/decouple-square-activity-from
title: Decouple Square activity from privileged host delivery
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdBy: codex
createdAt: 2026-08-27T06:02:47.957Z
updatedAt: 2026-08-27T19:27:26.089Z
---
Refactor Square so join, express, catch, and related artifact operations commit without requiring user-home or wake-transport access. Add executor-neutral action capabilities and ports, support privileged user host state plus repository-local fallback discovery for restricted agents, let hooks/CLI/daemons reconcile bindings and derive pending delivery from square state, remove direct action-to-hook/worker coupling, obtain Faye architecture review before binding, and complete implementation through reviewed Akuma delivery.
