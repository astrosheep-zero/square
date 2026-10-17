# MCP connection lifetime

An MCP server owns one artifact connection for its configured square. Its lifetime ends on close or disconnect; create a new server instance for a new connection. Replacing an artifact file under a running server remains unsupported. Every tool call still creates an application with that request's participant and harness session. Calls with an explicit `location` override instead open and close a per-call connection, leaving the configured-square owner untouched. Only the default connection is shared: authorization, presence, activity facts and cancellation remain operation-scoped. The artifact port already serializes transactions on its connection.

`createSquareResourceOwner()` is the explicit lifetime boundary. `scoped()` borrows its connection; ordinary application callers still open and close their own. Cross-square `inbox()` reads remain independent. The connection captures no request abort signal. Explicit server close and transport disconnect share one shutdown path: the SDK cancels requests, handlers finish their cleanup, then the connection closes.

## Local measurement

Compared with `fc6fca0`, using `/tmp/square-mcp-demand-bench.mjs` and real MCP calls over the SDK's in-memory transport. Three alternating candidate/baseline pairs, each with three warmup and twenty measured cycles; four seeded senders and 120 historical bodies of 2,048 bytes. No tests or builds ran during these pairs. Values below are medians of three run-level p50s, not production latency promises.

| Operation | Before (ms) | After (ms) | Artifact SQL prepares per call |
| --- | ---: | ---: | ---: |
| Repeated no-op join | 1.000 | 0.630 | 15 → 11 |
| Express | 3.404 | 3.080 | 61 → 57 |
| Empty catch, one sender | 1.648 | 1.247 | 40 → 36 |
| Empty catch, three senders | 1.643 | 1.210 | 42 → 38 |
| History | 0.805 | 0.432 | 16 → 12 |
| Status | 2.135 | 1.702 | 94 → 90 |

Read transaction counts remain unchanged. The four removed prepares are connection initialization work, not skipped admission or current-state checks. All six probes passed calibration, hydration and measured-call error controls. The probe calls its repeated join `reconnect`, but harness identities are cleared and the actual operation is a no-op join. This workload has no ownership contention or bulk catch payload.

The focused MCP test instruments connection initialization directly: six tool calls open one connection. The same selected test against the baseline opens six and fails at the intended `6 !== 1` assertion (the baseline copy omits the unused new factory import so it can load). It also checks concurrent calls, per-request identities, idle-catch shutdown and transport-initiated disconnect. Raw local measurements are `/tmp/square-resource-cache-{before,after}-{1,2,3}.{json,log}`.
