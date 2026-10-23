# Square for Paseo

Presentation for Square custom messages, plus a server entry that records Claude
native custody diagnostics. It never changes admission policy, sends a second
notification, marks an activity seen, or alters model context.

## Install from GitHub

```bash
paseo plugin install git:astrosheep-zero/square:plugins/paseo
```

Use `--ref <tag-or-branch>` to select an existing ref that contains the plugin
directory. Square tags up to v0.3.69 do not contain it.

Paseo supplies all runtime modules. No Git preparation step is needed. Plugins
are trusted, unsandboxed code running inside the Paseo app.

The server entry requires the local **Paseo 0.12.1-square.1** patch build, based
on official 0.12.0 and adding `agent.delivery_status`. Official 0.12.0 does not
provide that API. The manifest pins the tested patch build rather than claiming
support for an unpatched or hypothetical future official release. The client
card uses custom-message tool rows (#6090).
Square 0.3.69+ provides `details.items` for the collapsed heading. Messages without
those details still expand to their original content.

## Display

Only synthetic `tool_call` items with `metadata.customType === "square"` and
plain-text detail are projected into a card. Real tools, other custom messages,
and unrecognized rows remain unchanged.

The collapsed heading uses `metadata.details.items`; it never reverse-parses
the content. Expansion shows `metadata.details.fullText` when available: complete
notification bodies, even when the model preview was clipped or omitted. Older
messages fall back to `detail.text`, including clipping notices and catch commands.
Long content scrolls inside a bounded panel. The
card does not fetch extra activity or mark anything seen. Live events and fetched history use
the same transformer.

The card is visually marked as Square: an accent glyph, a SQUARE badge, and the
square's name sit above the actor line, on a raised surface distinct from ordinary
tool output. It uses Paseo theme colors, selectable text, accessible expansion state,
and compact layout on narrow displays. Expansion starts at the top-right arrow;
collapse returns from the arrow below the expanded content. Removing the plugin restores Paseo's
ordinary custom-message row.

## Native custody evidence

Paseo renders Claude `peer_message_hold` events as timeline notifications. The
server entry forwards socket observations (original event ID, native session and
message ID, held/released/dropped state, reason and observation time) to
`square claude-mod` over JSON stdin in the agent's working directory. Square
matches a message ID persisted before sending and appends the observation to the
original wake attempt. Unknown message IDs create no evidence. Failures surface
as plugin hook errors; forwarding is bounded to five seconds and honors hook
cancellation.

`held`, `released` and `dropped` are not queue receipts or proof of consumption.
They never turn `unknown` into `accepted` or authorize a replay. `square harness
doctor delivery` shows the native state and reason, including after the activity is seen.
The `square` executable must resolve to the matching Square release on the daemon's PATH.

## Develop

```bash
cd plugins/paseo
npm ci
# Link the SDK from the built Paseo 0.12.1-square.1 source checkout:
npm link --no-save /path/to/paseo/packages/plugin
npm run typecheck
npm test
paseo plugin install "$PWD"
```

After editing an installed directory source:

```bash
paseo plugin reload square
```

Plugin-only reloads need no Paseo restart once the host provides the lifecycle
API. Reloading a plugin cannot add that API to an older daemon. The plugin ID is `square`.
