# Default suite timing evidence

Same machine. Same Node/npm commands. `/usr/bin/time -p` real seconds.

## Commands

Default suite (Contract Verification):

```
/usr/bin/time -p node --test test/square-cli.test.js
/usr/bin/time -p npm test
```

Isolated CLI rendering, outside `test/*.test.js`. The script builds first because these cases import `dist`:

```
npm run test:cli-process
```

That script is `npm run build && node --test test/process/square-cli-render.test.js`.

## Measurements

| Suite | Command | Before | After |
| --- | --- | --- | --- |
| CLI smoke | `/usr/bin/time -p node --test test/square-cli.test.js` | 74.77s | 10.43s |
| Default `npm test` | `/usr/bin/time -p npm test` | 79.64s | 14.02s |
| Isolated CLI rendering | `npm run test:cli-process` | n/a | 17.64s real (29 pass) |

Isolated rendering is not part of the default glob. Run `npm run test:cli-process` to keep those assertions green.
