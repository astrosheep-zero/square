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
cards use `details.items` with producer-neutral presentation facts: `kind: 'presentation'`, `origin`,
`at` (landing time in epoch milliseconds), `reach` (`mention`, `reply`, `attention`, or `bell`),
optional `author` and `ref`, and the full Markdown `body`. Missing or malformed details fall
back to the original plain text.

## Display

Only synthetic `tool_call` items with `metadata.customType === "square"` and
plain-text detail are projected into a card. Real tools, other custom messages,
and unrecognized rows remain unchanged.

The header and messages use `metadata.details.items` directly, without parsing
notification envelopes for attribution. Messages remain oldest first in both states,
with an inline author, direct reach label, timestamp and individual guide. Contiguous
activity references from one origin form a range; gaps stay explicit. Body text
containing Square tags is ordinary content.

Both states share the same Markdown and one 32,000 UTF-16-unit display budget,
including omission lines. Long bodies retain their beginning and end without splitting
surrogate pairs. The collapsed window shows up to 4 body lines and ends after the last
whole measured text line. Expansion moves only the bottom edge, up to 260px, then
scrolls internally. Short content has no chevron or expansion action. Plain or malformed details use bounded `detail.text`
with a neutral heading. Rendering never fetches producer storage or marks activity seen.
Live events and fetched history use the same transformer, and model input is unchanged.

The slate palette follows the host theme. The header toggles overflowing content and
exposes its expansion state to assistive technology. Removing the plugin restores
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
