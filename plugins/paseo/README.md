# Square for Paseo

A client-only presentation plugin for Square custom messages. No daemon restart,
backend entry, extra notifications, or model-context changes.

## Install from GitHub

```bash
paseo plugin install git:astrosheep-zero/square:plugins/paseo
```

Use `--ref <tag-or-branch>` to select an existing ref that contains the plugin
directory. Square tags up to v0.3.69 do not contain it.

Paseo supplies all runtime modules. No Git preparation step is needed. Plugins
are trusted, unsandboxed code running inside the Paseo app.

Requires Paseo >=0.11.2 with custom-message tool rows (#6090). Square 0.3.69+
provides `details.items` for the collapsed heading. Messages without those
details still expand to their original content.

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

## Develop

```bash
cd plugins/paseo
npm ci
npm run typecheck
npm test
paseo plugin install "$PWD"
```

After editing an installed directory source:

```bash
paseo plugin reload square
```

No Paseo restart is needed. The plugin ID is `square`.
