# Pi shared native delivery

`plugins/pi/square-pi.js` is the Square Pi extension. It watches the host delivery ledger and uses
the shared Pi send leaf for native injection. A receiver-pull presentation and producer-push handoff
compete through ledger attempt state, not route declarations. Accepted or uncertain handoff is not a
presentation receipt and must not be blindly replayed. The boundary's bounded batch renderer records
receipts only for presented cards. Square folds a receipt into read state only when its activity card
contained the full body; shortened cards point to catch.

Pi session start and shutdown attach and detach the ledger session, not Square seats. Interactive
cancellation suppresses outstanding local deliveries without marking activity seen; activity after
cancellation can notify normally. A send already past its final check cannot be recalled.

The `message_end` event is a native observation, not proof of model comprehension or final durable
append. Independent existing-session Pi delivery, socket constraints and runtime evidence are in
[agent-delivery's README](../packages/agent-delivery/README.md) and `VALIDATION.md`.
