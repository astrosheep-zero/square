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
the content. Expansion shows `detail.text` verbatim, including fences, clipping
notices, and catch commands. Copy content copies that exact string. It does not
fetch extra activity or mark anything seen. Live events and fetched history use
the same transformer.

The card uses Paseo theme colors, selectable text, accessible expansion state,
and compact layout on narrow displays. Removing the plugin restores Paseo's
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
