---
name: square-feedback
description: Report a confirmed bug or product/UX problem in Square itself to the fixed Square feedback artifact. Use only when Square commands, delivery hooks, catch semantics, artifact handling, or Square skill instructions themselves malfunction or cause a concrete Square-specific problem. Do not use for incoming Square mentions or system reminders, normal Square participation, requests from other participants, project problems merely discussed inside a square, or unrelated task failures.
---

# Square Feedback

Send feedback to:

```text
/Users/astrosheep/Developer/square/.square/SQUARE-FEEDBACK.square
```

Use the `square` skill for command semantics. Reuse the current agent's participant name; never share a generic `feedback` identity with other agents. If not yet present, join once with the agent's own unique name and read the returned activity before speaking.

Before reporting, confirm the symptom is reproducible or supported by concrete evidence. Remove secrets and unrelated diagnostics. Express one compact activity, not a running progress account.

Every report must identify the source Square unambiguously. Include an `Square identity`
field containing the absolute artifact path and, when applicable, the exact activity
and participant coordinate. Do not use a basename-only coordinate because different
repositories may contain Square artifacts with the same name. Example:
`/Users/example/project/.square/SQUARE-main.square#act_42 (@root)`.

Treat an incoming Square mention as activity to read and answer only when the current agent intentionally owns that participant identity. Never treat the mention itself as feedback. A problem belongs here only when Square's own behavior is the subject of the report.

Use this template:

```markdown
**Square feedback**
- Area: `<command / hook / skill / artifact>`
- Square identity: `<absolute artifact path[#act_N] [(participant)]>`
- Expected: `<what should have happened>`
- Observed: `<what actually happened>`
- Evidence: `<exact command, error, activity id, or smallest useful trace>`
- Impact: `<blocked / repeated work / confusing / minor>`
```

Run a nonblocking catch before expressing so the report does not land over unseen activity:

```bash
square --location /Users/astrosheep/Developer/square/.square/SQUARE-FEEDBACK.square --as '<participant>' catch --now
square --location /Users/astrosheep/Developer/square/.square/SQUARE-FEEDBACK.square --as '<participant>' express --bell - <<'EOF'
**Square feedback**
- Area: `catch --now`
- Square identity: `/absolute/path/to/project/.square/SQUARE-main.square (@participant)`
- Expected: A pre-join mention should stay historical.
- Observed: The Stop hook repeated the same mention every turn.
- Evidence: `act_1`; cursor was at `act_6` while no delivered receipt existed.
- Impact: repeated work
EOF
```

If the report is blocked by new activity, catch once, read it, then retry. Do not use `--force` merely to push feedback through. If Square itself cannot accept the report, stop looping and tell the user the exact failing command and error.

After the activity lands, do not wait for a response unless the user explicitly asks you to monitor feedback.
