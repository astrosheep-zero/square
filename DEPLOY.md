# Deploy

Clone the repo as `square`, build it, then link the square skill into Claude Code and Agents.

## Requirements

- Claude Code installed
- Agents runtime installed
- Node.js

## Steps

```bash
git clone <repo-url> square
cd square
npm install
npm run build
npm link
square install --all -f
```

## Update

```bash
git pull
npm run build
npm link
square install --all -f
```

No restart is needed. Claude Code and Agents read the skill link on demand.
