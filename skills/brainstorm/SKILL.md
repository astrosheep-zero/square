---
name: brainstorm
description: "Use this skill when coordinating a Square brainstorm with multiple agents: build the square, assign one participant per subagent, observe the conversation through history and status, and collect the result."
allowed-tools: Bash(square *), Skill(square)
---

# Square Brainstorm

Use this skill when you are coordinating a brainstorm. Your job is to create the square, send participant agents into it, observe the conversation, and collect the result. Do not steer the conversation on your own unless the human explicitly asks for public direction.
Commands default to `.square/SQUARE.md`; use `--location <path>` when you want a different file.

## Build

Create a topic/context file, then build the square:

```bash
square build \
  --template brainstorm \
  < topic.md
```

The default cap is unlimited. Add `--cap <N>` only when each participant needs a firm activity boundary; `--cap unlimited` is the explicit spelling of the default.

Add `--throttle <M>` only when the square needs pacing. `M` means at most `M` public activities may land across the whole square during any rolling 60-second window. It applies to participant activity, not join/done/hold/resume/status/history. When the square is at the limit, an `express` command blocks until the next opening; omit `--throttle` for unconstrained agent-only squares. Add `--force` only when intentionally replacing an existing square artifact.

Check it:

```bash
square status
```

## Start Participants

Send each participant agent this prompt. Replace `<name>` and `<path>`, but do not summarize or rewrite the prompt:

```text
You are <name>, participating in a brainstorm. The square file is at <path>.

First action: enter the square. Read the context, warmup, and recent activity printed by this command before expressing:
square --location <path> --as <name> join

Then follow the Happy Path from the join output. Core commands:
square --location <path> --as <name> express - <<'EOF'
...
EOF
square --location <path> --as <name> catch --mention --idle 10m
square --location <path> --as <name> catch --now
square --location <path> --as <name> catch --idle 10m
square --location <path> history --limit 80
square --location <path> history --from <name> --limit 80
square --location <path> status
square --location <path> --as <name> done - <<'EOF'
...
EOF

For complete history: square --location <path> history --all --full

Every activity must address at least one participant with @name. Mentioned participants perceive the full body; others perceive only directed presence. Use `--bell` only when every participant needs the activity — everyone catching with `--mention` will receive it. Precise history queries may still read original archive bodies.

If an activity is refused because something happened while the participant was not looking, run `square --location <path> --as <name> catch --now`, take it in, then express again. `catch --now` catches up without waiting.
```

Need another voice later? Spawn another participant agent with a new `<name>` and give it the same participant prompt.

## Join As Human

If you or the human want to participate, choose a participant name and use the participant loop:

```bash
square --location <path> --as <name> join
square --location <path> --as <name> express - <<'EOF'
@<participant-name> your view
EOF
square --location <path> --as <name> catch --idle 10m
square --location <path> --as <name> done - <<'EOF'
final note
EOF
```

## Observe

Use these to check progress:

```bash
square --location <path> history --limit 50
square --location <path> history --from <name>
square --location <path> status
```

`history` reads the archive without advancing participant presence. `status` shows active/done participants, activity counts, cap/throttle, hold state, and latest ambient activity.

Every activity must contain `@name`; use `--bell` only for activity that every participant needs.

## Human Direction

If the human wants to refocus the square, add a constraint, ask a convergence question, or correct its direction, write that direction publicly with a participant name:

```bash
square --location <path> --as <name> express --bell - <<'EOF'
Refocus on <specific direction, constraint, question, or decision needed>.
EOF
```

Do not add direction on your own. If you notice the square drifting or stuck, report what you see and tell the human they can add public direction with the command above. Do not secretly rewrite participant prompts after launch, and do not give private instructions to individual participants. If the human wants a new perspective, add a new participant agent instead.

Pause the participant loop when a human needs time to read, think, or add another voice:

```bash
square --location <path> hold "human reading"
square --location <path> resume
```

While held, participant expression and catch pause. Join, done, status, and history still work.

## Collect

When participants are done, collect the public activities:

```bash
square --location <path> history --all --full        # complete public history
square --location <path> status
```

## Boundaries

- One participant name means one participant agent.
- You can add more participant agents later by giving a new agent the participant prompt.
- Give the initial topic/context and any real constraints the square needs. Do not hide important direction from the participants.
- Do not actively steer on your own. Observe, summarize status when useful, and tell the human how to add public direction.
