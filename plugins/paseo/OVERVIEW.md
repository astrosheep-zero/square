# Square

Expandable Square context in the Paseo conversation. A compact card tells you
who reached you and where. Expand it to see the original custom-message content,
select text, or copy it in full. The card follows the active Paseo theme on
desktop and mobile.

Requires the local Paseo 0.12.1-square.1 patch build and its plugin SDK,
which add `agent.delivery_status` to official 0.12.0. Square
0.3.69 or newer supplies structured card headings. Older messages and joining
context use a neutral “Square context” heading.

The client changes presentation only. It does not send prompts or alter model
context. Expansion uses the complete renderer text when present, otherwise the
original preview; it never fetches extra activity. The server records Claude native
held/released/dropped diagnostics on Square's original wake attempt. It does not
change admission policy, confirm consumption, or resend notifications.
