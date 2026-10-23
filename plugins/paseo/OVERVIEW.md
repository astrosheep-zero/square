# Square

Expandable Square context in the Paseo conversation. A compact card tells you
who reached you and where. Expand it to see the original custom-message content,
select text, or copy it in full. The card follows the active Paseo theme on
desktop and mobile.

Requires Paseo 0.11.2 or newer with custom-message tool rows (#6090). Square
0.3.69 or newer supplies structured card headings. Older messages and joining
context use a neutral “Square context” heading.

The plugin changes presentation only. It does not send prompts or alter model
context. If Square clipped a body before delivery, expansion shows that same
preview and the command for reading the rest, not an additional fetch.
