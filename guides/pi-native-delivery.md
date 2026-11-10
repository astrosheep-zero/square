# Pi shared native delivery

`plugins/pi/square-pi.js` is the Square Pi extension. It watches the host delivery ledger and uses
the shared Pi send leaf for native injection. A receiver-pull presentation and producer-push handoff
compete through ledger attempt state, not route declarations. Accepted or uncertain handoff is not a
presentation receipt and must not be blindly replayed. The boundary's bounded batch renderer records
receipts only for presented cards. Square folds a receipt into read state only when its activity card
contained the full body; shortened cards point to perceive.

Display items come directly from validated producer-neutral card details (`origin`, optional `author`
and `ref`, landing time `at`, `reach`, and full Markdown `body`). Display never opens Square history. Missing or invalid
details fall back to card text. Model-facing reminder text is unchanged, and a full display body does
not make a shortened model-facing card eligible to consume producer unread activity.

The human card keeps delivery order, oldest first. Both states share the same Markdown wrapping,
inline author/reach and right-aligned local time column. Collapsing keeps four non-blank rendered body
lines and skips blank rows; hidden non-blank lines add an omission mark and an exact `+N lines` footer.
Expansion preserves the original blank rows, without message separators or a footer. Direct reaches use warning-colored labels and guides.
The header merges only contiguous activity references within one origin. Time, reach and reference
formatting is shared with Paseo. Every final line is bounded by the terminal width, including legacy
Markdown fallback and very narrow terminals.

Pi session start and shutdown attach and detach the ledger session, not Square seats. Interactive
cancellation suppresses outstanding local deliveries without marking activity seen; activity after
cancellation can notify normally. A send already past its final check cannot be recalled.

The `message_end` event is a native observation, not proof of model comprehension or final durable
append. Independent existing-session Pi delivery, socket constraints and runtime evidence are in
[agent-delivery's README](../packages/agent-delivery/README.md) and `VALIDATION.md`.
