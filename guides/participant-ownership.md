# Participant ownership

Membership and host attachment are distinct. Square owns the standing participant, opaque owner,
join generation, listens and read horizon. The host delivery ledger owns session attachment and
routes; it does not own membership. An owner is not an authentication credential.

`done` ends membership and outgoing listens. After the leave commits, Square best-effort withdraws
matching posted cards for that captured participant and join generation when they are not already in
ledger custody. It does not consume producer history or recall an in-custody effect. Cleanup failure
does not undo the leave or make it retry. A later join establishes a fresh generation; explicit takeover fences the
previous owner and generation. Host end only detaches the ledger session:
the participant remains away without a timeout, retains audience and unread activity, and cannot
write or receive proactive delivery. Start/resume attaches the ledger session, not individual seats;
there are no seat restore or detach hooks. A voluntary departure or takeover is never resurrected.
Host-confirmed deletion marks the ledger session deleted; the next privileged mutating Square
operation reconciles it and lands a generation-fenced `done`. Read-only history, status and
participants do not perform that mutation.

Participant handles capture owner and join generation; stale, departed or replaced custody refuses.
Sandbox selection and exact ACK authorize against locally known World custody alone,
without requiring access to the user ledger. This is not proof of current host attachment: a ledger-only
detach or deletion is learned at the next privileged producer reconciliation. A local control never
grants host delivery authority or revives a deleted session; export checks the actual ledger state.

Exact future ACK is producer-owned and recipient-scoped; see [square-api.md](square-api.md).
Proactive delivery suppression belongs in the host delivery ledger; see
[delivery-primitives.md](delivery-primitives.md).
