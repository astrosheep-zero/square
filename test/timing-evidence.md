# Default suite timing evidence

Timed commands, run from each tree's root after building that tree once:

```
/usr/bin/time -p env -u SQUARE_HOST_LEDGER_ROOT node --import ./test/sandbox-env.js --test test/*.test.js
/usr/bin/time -p env -u SQUARE_HOST_LEDGER_ROOT node --import ./test/sandbox-env.js --test test/process/square-cli-render.test.js
```

Each round is one warmup plus three measured runs per tree, with the file glob
expanded inside that tree's working directory; medians are `real` seconds.

| Suite | Parent a7f1fcaa median | Candidate median |
| --- | --- | --- |
| Default suite | 19.05s | 17.70s |
| Opt-in CLI rendering | 24.09s | 3.43s |
