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
notification envelopes for attribution. Messages remain oldest first in both states.
Both states keep the same Markdown and individual guides. The origin owns the header's left side and a tally of small seal marks — one per message, a mark and a figure past five, none for a lone message — owns its right. Within each message, author, reach and timestamp form the left group while its own reference stands alone at right; the body runs full width beneath them. Body text containing Square tags is ordinary content.

Both states use one 32,000 UTF-16-unit source display budget, including omission lines.
Long bodies retain their beginning and end without splitting surrogate pairs.
Collapsed cards clip the Markdown after the byline and four 20px body lines; the edge may cut through a line.
Expansion raises the limit to 260px and enables internal scrolling without replacing the content.
Collapsed overflow cards open from their header or body; expanded cards collapse from the header, leaving scrolling, text selection and links unobstructed.
Short cards do not toggle. A header chevron appears only when content exceeds the collapsed limit.
No custom line measurement is needed. Plain or malformed details use bounded `detail.text`
with a neutral heading. Rendering never fetches producer storage or marks activity seen.
Live events and fetched history use the same transformer, and model input is unchanged.

The slate palette follows the host theme. Web cards add weak static mineral grain beneath a flat veil; native cards keep the same matte base and plane-internal cut edges without `url()` backgrounds. No card casts a shadow. The header exposes expansion state to assistive technology. Removing the plugin restores
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

## Markdown maintenance

`client/markdown-core.tsx` and `test/markdown-core.test.ts` are manually mirrored,
byte-for-byte, between the Square and pi-context (notesoup) repositories at
`plugins/paseo/`. No shared package or cross-repository runtime import is needed.
When changing rendering behavior, copy both files to the other plugin and run
`npm test && npm run typecheck` in both plugin directories. Compare the files
with `diff -u` before delivery. Each `client/markdown.tsx` owns its palette and
wrapper; do not copy those adapters.

The core handles inline nesting, block structure, selectable text, safe `http(s)`/`mailto`
link presses, and horizontal code/table scrolling. Images render as alt text or `[image]`;
this is not the full Paseo assistant renderer. Tests inspect React elements with RN host
primitives, not native layout. Verify wrapping, selection and scrolling on iOS
before claiming visual or gesture correctness.
