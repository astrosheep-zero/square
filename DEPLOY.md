# Deploy

Install the published Square CLI, then install its integrations through the
native harness commands. Pi receives Square as the published npm package unless
an existing local Square package is already configured; that source is preserved.

## Requirements

- For Claude native inbox delivery: macOS Claude Code, with the
  Square mod actually loaded in a trusted/approved interactive terminal
- OpenCode 1.x uses the separate legacy plugin; native proactive delivery requires 1.15.11 or newer and a runtime supporting Square's SQLite API. OpenCode 2.x uses the separate v2 server plugin.
- Node.js 22.16.0 or later within the 22.x line, or 24.0.0 or later

## Steps

```bash
npm install -g @astrosheep/square
square install --all -f
```

`square install opencode` checks the installed OpenCode major first. For 2.x it uses the npm loader and `./server`; for 1.x it configures the separate `./opencode-v1` function by an absolute file URL to this Square installation. Re-run installation after moving or upgrading Square. A missing entry with an intact Square package manifest can be refreshed; if the old package root and manifest are gone, doctor reports unverified ownership and preserves that URL for manual inspection. Configuration does not prove a running host loaded the plugin.

On 1.x, a host below 1.15.11, without a reachable native health endpoint, or without the required SQLite runtime uses reduced integration: no resident receiver or proactive delivery. Explicit Node CLI catch/history remains available. Shell session identity is supplied only when OpenCode provides it (1.2.7 or newer); on older hosts use the native session ID explicitly, for example `square --owner 'opencode:<native-session-id>' ... catch --idle` or the corresponding history command. No tool-output injection is used.

A 1.x native 204 is uncertain submission, not admission or presentation. Exact prepared text observed at Square's pre-model hook may record presentation; later plugins can still remove it. This does not prove provider receipt, model processing or human acknowledgement. An isolated OpenCode 1.19.5 `opencode serve` supports native proactive delivery in the tested setup; 1.15.11 was tested in reduced mode. The tested 1.19.5 interactive embedded TUI currently runs reduced, without proactive delivery, because its supplied health URL is unreachable. Other versions and platforms are not thereby certified. On 2.x user cancellation suppresses the local pending batch, not already admitted native input.

For an authenticated 1.x session deletion, Square stops that session's local receiver and discovers its seats during the deletion handler; it ends only the owner and generation captured for each seat. This is a handler-observation boundary, not an atomic snapshot at the remote event time or a permanent cross-process tombstone.

The v2 plugin checks its version family and required location, session and event capabilities at setup. OpenCode 2.0.20 was tested; other eligible 2.x releases have not been individually validated and future API changes can break compatibility.

Pi treats local paths and npm names as different package identities. Do not configure
both sources for Square: they register the same tools twice. `square install pi`
(and `--all`) preserves an existing local source instead of adding an npm copy;
`square harness doctor pi` checks that local package as the active installation.

## Plugin sources

Host-specific entries live under `plugins/pi`, `plugins/claude`, `plugins/codex`,
`plugins/opencode`, `plugins/opencode-v1`, and `plugins/paseo`. Package metadata and native install
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
