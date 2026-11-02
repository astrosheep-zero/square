# Deploy

Install the published Square CLI, then install its integrations through the
native harness commands. Pi receives Square as the published npm package unless
an existing local Square package is already configured; that source is preserved.

## Requirements

- For Claude native inbox delivery: macOS Claude Code, with the
  Square mod actually loaded in a trusted/approved interactive terminal
- For OpenCode native body delivery: installed **2.0.20** with the Square v2 server plugin loaded
- Node.js 22.16.0 or later within the 22.x line, or 24.0.0 or later

## Steps

```bash
npm install -g @astrosheep/square
square install --all -f
```

The OpenCode integration is installed from the published `@astrosheep/square`
package through OpenCode's npm plugin loader. The package's `exports["./server"]`
entry tells OpenCode which `{ id, setup }` server plugin to load. Square still
links its skills into the local agent configuration. The loaded plugin sends
body previews through OpenCode's own session capability while idle or busy;
only an exact matching prepared primary context records presentation. Native
admission alone is not presentation. User cancellation suppresses the local
pending batch, not OpenCode's already admitted inbox or unrelated execution.
No legacy tool-output injection fallback is installed; other builds are not
claimed as validated.

Pi treats local paths and npm names as different package identities. Do not configure
both sources for Square: they register the same tools twice. `square install pi`
(and `--all`) preserves an existing local source instead of adding an npm copy;
`square harness doctor pi` checks that local package as the active installation.

## Plugin sources

Host-specific entries live under `plugins/pi`, `plugins/claude`, `plugins/codex`,
`plugins/opencode`, and `plugins/paseo`. Package metadata and native install
recipes select their entries; moving the sources does not change the existing
`square install` commands or OpenCode's public `./server` export.

The optional Paseo client plugin only changes Square custom-message presentation:

```bash
paseo plugin install git:astrosheep-zero/square:plugins/paseo
```

It uses Paseo's runtime plugin loading and does not require a daemon restart.
See [Square for Paseo](plugins/paseo/README.md) for requirements and development.

Square's separate Paseo wake integration uses the optional `@getpaseo/client`
peer at version `0.14.0`. Install that peer when using Paseo wake; ordinary
Square operation does not require it.

## Update

```bash
npm install -g @astrosheep/square@latest
square install --all -f
```

Claude must load the updated Square mod. Start a new trusted interactive
conversation (or confirm its mod hot reload); installing the plugin or finding
an inbox socket alone does not prove it loaded. Approve the mod through Claude's
normal UI. A disabled/unapproved mod, the ordinary unapproved headless `-p` path,
other Claude builds, and other platforms are unavailable until validated. There
is no legacy injection fallback.

Run `square harness doctor claude` for installation/capability guidance and
`square harness doctor delivery` for current receiver routes and delivery
evidence. See [Claude native inbox](guides/claude-native.md) for membership,
admission, cancellation, and native custody limits. Other harnesses retain
their existing installation and delivery paths.

## Square persistence

The user-level host ledger is a separate `host-ledger.sqlite`, also using
DELETE/FULL. `square ledger verify` is read-only and needs no square location
or participant. `square ledger gc` reclaims only artifact-proven closed delivery
evidence; freed storage can be reused but the file need not immediately shrink.
Small permanent Claude recognition tokens remain, and their total count is unbounded.
Do not roll back to retained NDJSON files after SQLite writes have begun.

Each `.square` artifact is a transactional SQLite database using DELETE journal
mode and FULL synchronous writes. Ordinary opens refuse older or unsupported
artifact formats; they do not convert them.

Close all Square access before moving an artifact. For a live artifact, use
SQLite's backup facilities; copying only the main `.square` file is not a safe
backup.
