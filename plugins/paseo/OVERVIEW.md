# Square

Expandable Square context in the Paseo conversation. A compact card tells you
who reached you and where. Expand it to see the original custom-message content,
select text, or copy it in full. The card follows the active Paseo theme on
desktop and mobile.

Requires Paseo 0.11.2 or newer with custom-message tool rows (#6090). Structured messages
carry producer-neutral origin, author, reference, landing time, reach and full body details. Plain messages and
joining context use a neutral notification heading.

The plugin changes presentation only. It does not send prompts or alter model
context. Expansion shows the delivered full display body, within a bounded preview,
while model-facing text stays clipped as before. No producer storage fetch is needed.
