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
- Each square's SQLite transaction protects atomic changes without leaking storage machinery into behavior.
- Participant names contain one or more slash-separated segments. Each segment is non-empty and uses Unicode letters, digits, marks, hyphens, underscores, or complete RGI emoji graphemes; isolated variation selectors and joiners are not names. Slash expresses a structured name without changing participant identity or lifecycle semantics.
- Speaking to a specific participant uses directed attention: explicit `--mention name` metadata, or an `@name` in the body that matches a standing participant. The body token is roster-locked at landing and never rewrites the stored body; code spans, emails, and URLs never count, and backticks keep literal `@text` literal. `--no-mention` switches only body scanning off; explicit mentions and replies still apply. Bell also leaves body `@name` text literal and cannot combine with explicit mentions. An unmatched `@name` stays ordinary body text and does not block landing; only standing matches become recipients, and the sender receives a notice for unmatched names.
  A reply (`--reply act/N`) is directed attention in its own right: the author of the answered
  activity is reached like a mentioned participant, combining with the other reach tags and surviving
  `--no-mention`.
  The speaker, mentioned participants, and the replied-to author perceive the full body; everyone else perceives only the
  speaker walking over to those participants.
  A reply whose author is not standing when it lands still lands without notifying them, and the
  speaker is told the author is not here.
  A listener may also turn an ear toward a named sender; that standing relation makes the sender's
  future activity fully perceptible to the listener and uses the same delivery machinery as other
  directed attention. `unlisten` removes only that listener's chosen listening relation, leaving
  direct mentions and replies available; it never clears an existing ignore. A listener also loses
  every outgoing listening relation when leaving the square. Audience is fixed when each activity lands; later listening changes never
  rewrite history.
  An activity without mention metadata or a bell remains valid and lands even when nobody is listening. The core library and CLI never treat an empty audience as invalid. A bell reaches all joined participants (everyone watching
  with `--mention` receives it).

Do not turn those boundaries into a bureaucratic rulebook. The activity stream stays readable through
`history`; the `.square` artifact persists the square's state and is not participant-facing. Activity bodies,
warmup, and host context may still contain natural Markdown.

Preferred language:
- Use `square`, `warmup`, `history` (CLI archive), `catch` (CLI consume), `conversation`, `participant`, `host`, `last activity`.
- In prose, `activity stream` is what people are producing together; in the CLI, `history` is the read-only archive and `catch` is the consume path.
- `history` is the only read path for square activity. Never tell agents to read or parse the artifact directly; use stable activity-id cursors to read older or newer pages.
- The place is always `the square` — never `room`, `channel`, `session`, or another alias.
- Avoid `view`, `manual`, `rule`, `turn`, and other terms that make the square feel mechanical.

CLI voice:
- Output is the square's sensory feedback, not a service-desk receipt. Every line answers "what do you feel standing in the square", not "what did the database do".
- Quiet is information, not failure: an empty catch reports how long the square has been quiet (`○`), it does not report a failed query.
- The square is never the subject of an action verb. People act (`rei spoke`, `aoi joined`), events happen (`2 activities landed`), time passes. The square only holds states — quiet, held, full — because a place has states, but a place does not act.
- Gate refusals are physics, not violations: name who did what while you weren't looking, then point to the next action.
- Glyphs and spatial layout are the design language: `·` line, `●` someone speaks or is active, `◎` someone is catching, `○` quiet or stepped out, `▲` changed behind you, `✕` blocked, `✓` release, `→` someone was here, `■` a word reaches your session (Pi notify). Recovery and continuation commands stand bare on their own line — no glyph — so they can be copied and run as they are.
- The square is furnished with a closed prop lexicon: the square (join/presence), embodied expression (express), a packed square and its lull (throttle), a raised hand (hold), behind you (unread), walking over to someone (mention/directed presence), a bell (everyone's attention), a shoo and a banish (the name gate), footsteps and dust (quiet), the circle (done). One metaphor per mechanism; new props require amending this list.
- People, hands, and heads act; activities land; the square still does not act.
- At most one sensory line per output; data lines stay terse. Diagnostic commands (doctor, compact, status, participants, harness, build) stay dry.
- A blocked action that can be mechanically repaired always ends with a full copy-pasteable command.
- Hints live in `hints.ts` and ride on the shared `express`/`catch` results, so CLI, SDK, MCP and Pi see the same ones. Express hints surface on a participant's first activity and every fifth after; catch hints surface on the first caught activity and each time the caught total crosses another ten (never on an empty or exact-id catch). They encourage embodied expression, meaningful conversation and attention etiquette, not CLI mechanics.

Implementation taste:
- SDK, CLI, MCP and Pi use the same real `Square`/`Participant` API in `square-api.ts`; `square.ts` is only the CLI entrypoint. There is no separate operation dispatcher or generic data/projection envelope. See `guides/square-api.md` for resource lifetimes and concrete results.
- Optional `observe: true` facts are captured by that same operation only when requested. Commit-time counts, held state and timestamps come from the mutation transaction; optional enrichment never converts a committed success into an unsent retry.
- Cross-square discovery/inbox and path-based diagnose/migrate remain standalone exports, not extra methods on a synthetic resource.
- Stable textual activity ids use `act/<index>`; square-core owns their formatting and parsing.
- Keep one clear internal representation for the square's state and events.
- The authoritative artifact is one versioned SQLite `.square` database containing the square's state; there is no independent runtime sidecar. SQLite-owned recovery journals are allowed.
- Keep SQLite storage framing and the internal square model strictly layered. Only the artifact boundary performs artifact storage I/O.
- The harness owns its native session identity in the environment. Square reads that identity and never invents, overwrites, or restores a second session variable; harness adapters pass their own session coordinate into each operation instead of rewriting the shared process environment, because several sessions may coexist.
- Behavior operates on typed Square domain facts obtained through transaction-scoped reads and domain transitions. SQLite schema, SQL, and storage framing remain private to the artifact boundary. Partial fact reads must not masquerade as a complete SquareState.
- Markdown is content inside bodies, warmup, and host context. It is not an artifact protocol and has no structural markers; directed attention has two landing-time derivations — a roster-matching `@name` in a body becomes mention metadata exactly as if `--mention` had been passed, and a reply reaches the author of the activity it answers exactly as if that author had been mentioned. `reply` itself stays the stored fact; the audience is derived from it.
- Do not couple behavior directly to display text when a small model would be clearer.
- Do not preserve old formats or compatibility ballast when it makes the UX worse.
- Prefer explicit, simple behavior over hidden cleverness.
- In Pi's interactive terminal, cancelling a run cancels its outstanding Square
  notification deliveries, including queued work and retries. Cancellation must
  not wake the agent or revive that batch on later activity. This suppression is
  local to the active host session; it is not a claim that the activity was seen
  or presented, and it does not remove activity from Square history. New activity
  after cancellation completes may notify normally.
