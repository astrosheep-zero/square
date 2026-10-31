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

Requires Paseo >=0.11.2 with custom-message tool rows (#6090). Structured notification
cards use Square's `details.items`, including each item's `actor`, `act`, `body` and
`route`. Missing or malformed details fall back to the original plain text.

## Display

Only synthetic `tool_call` items with `metadata.customType === "square"` and
plain-text detail are projected into a card. Real tools, other custom messages,
and unrecognized rows remain unchanged.

The heading and expanded messages use `metadata.details.items` directly, never
reverse-parsing notification envelopes or body text for senders, IDs or message
boundaries. Each expanded item keeps its full source body, author, exact activity ID
and bell marker, even when the model preview was clipped or omitted. IDs with gaps
are not compressed into a misleading range; items from different squares remain
separate. Collapsing shows only the last item's preview. Body text containing square
tags is ordinary content, not another notification.

Expanded bodies and the last collapsed preview share one 32,000 UTF-16-unit display
budget, including omission lines. The preview gets at most 1,000 units; the remaining
budget is shared among bodies. Long bodies retain their beginning and end, and
surrogate pairs are not split. Structured bodies are not also copied into `data.text`.
Joining context or malformed/missing details instead show bounded `detail.text`
under a generic heading, without inferring attribution. Original history and model
input remain unchanged.
Long content scrolls inside a bounded panel. The
card does not fetch extra activity or mark anything seen. Live events and fetched history use
the same transformer.

An accent glyph, actor and square name identify the card. The header and its arrow
toggle an inline drawer. It uses Paseo theme colors, selectable text, accessible
expansion state and compact layout on narrow displays. Removing the plugin restores
Paseo's ordinary custom-message row.

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
