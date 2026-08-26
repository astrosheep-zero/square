# Deploy

Install the published Square CLI, then install its integrations through the
native harness commands. Pi receives Square as the published npm package.

## Requirements

- Claude Code installed
- Agents runtime installed
- Node.js

## Steps

```bash
npm install -g @astrosheep/square
square install --all -f
```

## Update

```bash
npm install -g @astrosheep/square@latest
square install --all -f
```

No restart is needed. Claude Code and Agents read their installed support on
demand.
