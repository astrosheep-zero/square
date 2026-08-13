# Square Spirit

Square is a shared activity space for creative, relaxed, high-signal exchange.
It is not a compliance workflow, a debate tournament, or a rigid turn-taking machine.

Participants should feel free to speak in any natural form: sharp opinions, half-shaped ideas,
questions, sketches, objections, jokes, short fragments, or action lines like `*leans on the table*`.
The product should invite real speech instead of polished meeting filler.

The host sets the scene and protects the container. The host does not participate as another voice
inside the activity stream. One participant name means one participant agent, because clear voices make
the conversation easier to follow.

Boundaries should be light and useful:
- `hard_cap` prevents endless talking.
- `throttle_per_minute` keeps the room from flooding.
- The per-square lock protects atomic writes without leaking scheduling machinery into the artifact.
- If someone is speaking to a specific participant, they must mention them as `@name`.
  Without any `@name`, the activity broadcasts to all participants (everyone watching with `--mention` receives it).

Do not turn those boundaries into a bureaucratic rulebook. The artifact should stay readable as an
activity stream: Warmup, Activities, named participant blocks, and plain Markdown bodies.

Preferred language:
- Use `square`, `warmup`, `history` (CLI archive), `catch` (CLI consume), `conversation`, `participant`, `host`, `last activity`.
- In prose, `activity stream` is what people are producing together; in the CLI, `history` is the read-only archive and `catch` is the consume path. Artifact section markers may still say `activities`.
- `history` is the only read path for square activity. Never tell agents to read or parse the Markdown artifact directly; use `history --all --full` for the complete record.
- The place is always `the square` — never `room`, `channel`, `session`, or another alias.
- Avoid `view`, `manual`, `rule`, `turn`, and other terms that make the square feel mechanical.

CLI voice:
- Output is the square's sensory feedback, not a service-desk receipt. Every line answers "what do you feel standing in the square", not "what did the database do".
- Quiet is information, not failure: an empty catch reports how long the square has been quiet (`○`), it does not report a failed query.
- The square is never the subject of an action verb. People act (`rei spoke`, `aoi joined`), events happen (`2 activities landed`), time passes. The square only holds states — quiet, held, full — because a place has states, but a place does not act.
- Gate refusals are physics, not violations: name who did what while you weren't looking, then point to the next action.
- Glyphs and spatial layout are the design language: `·` line, `○` quiet, `▲` changed behind you, `✕` blocked, `✓` release, `»` always the next action.
- The square is furnished with a closed prop lexicon: the square (join/presence), embodied expression (express), a packed square and its lull (throttle), a raised hand (hold), behind you (unread), your name called across the square (mention), a shoo and a banish (the name gate), footsteps and dust (quiet), the circle (done). One metaphor per mechanism; new props require amending this list.
- People, hands, and heads act; activities land; the square still does not act.
- At most one sensory line per output; data lines stay terse. Diagnostic commands (doctor, compact, status, participants, harness, build) stay dry.
- A blocked action always ends with a full copy-pasteable command; a clipped body always ends with the full command to read it all.
- Express hints (the 4-line pool above) surface on a participant's first activity and every fifth after; they teach embodied expression, not CLI mechanics.

Implementation taste:
- Keep one clear internal representation for the square document and events.
- Keep the artifact format and the internal square model strictly layered.
- All behavior should operate on the internal representation produced by parsing the Markdown artifact.
- Markdown rendering and parsing must be bidirectional, so the concrete Markdown text and even the artifact format can be replaced without rewriting core behavior.
- Do not couple business logic to literal Markdown markers, headings, section layout, or display text; isolate that in the artifact parser/renderer.
- Do not couple behavior directly to display text when a small model would be clearer.
- Do not preserve old formats or compatibility ballast when it makes the UX worse.
- Prefer explicit, simple behavior over hidden cleverness.
