# Deploy

Install the published Square CLI, then install its integrations through the
native harness commands. Pi receives Square as the published npm package.

## Requirements

- Claude Code installed
- Agents runtime installed
- Node.js 22.16.0 or later within the 22.x line, or 24.0.0 or later

## Steps

```bash
npm install -g @astrosheep/square
square install --all -f
```

The OpenCode integration is installed from the published `@astrosheep/square`
package through OpenCode's npm plugin loader. The package's `exports["./server"]`
entry tells OpenCode which server plugin to load. Square still links its skills
into the local agent configuration.

## Update

```bash
npm install -g @astrosheep/square@latest
square install --all -f
```

No restart is needed. Claude Code and Agents read their installed support on
demand.

## Square persistence

Each `.square` artifact is a transactional SQLite database using DELETE journal
mode and FULL synchronous writes. Legacy artifact formats are not migrated.

Close all Square access before moving an artifact. For a live artifact, use
SQLite's backup facilities; copying only the main `.square` file is not a safe
backup.
