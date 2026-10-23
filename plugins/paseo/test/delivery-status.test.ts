import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDeliveryObservation, PluginHookContext, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { recordDeliveryStatus } from "../server/record-delivery.ts";

type DeliveryHandler = (event: PluginLifecycleEvents["agent.delivery_status"], context: PluginHookContext) => void | Promise<void>;

test("native lifecycle status is forwarded verbatim to Square, without changing admission policy", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "square-status-")));
  await mkdir(path.join(root, "bin"));
  const output = path.join(root, "record.json");
  await writeFile(path.join(root, "bin/square"), `#!/usr/bin/env node
(async () => {
let input = ''; for await (const data of process.stdin) input += data;
if (process.env.SQUARE_TEST_FAIL) process.exit(2);
require('node:fs').writeFileSync(process.env.SQUARE_TEST_OUTPUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input: JSON.parse(input) }));
})().catch(() => process.exit(3));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}/bin:${oldPath}`;
  process.env.SQUARE_TEST_OUTPUT = output;
  t.after(async () => {
    process.env.PATH = oldPath;
    delete process.env.SQUARE_TEST_OUTPUT;
    delete process.env.SQUARE_TEST_FAIL;
    await rm(root, { force: true, recursive: true });
  });
  let handler!: DeliveryHandler;
  let cleaned = false;
  const on = ((name: string, callback: DeliveryHandler) => {
    assert.equal(name, "agent.delivery_status");
    handler = callback;
    return () => { cleaned = true; };
  }) as PluginServerContext["on"];
  const cleanup = contribute({ on });
  const agent = { id: "paseo-id", workspaceId: null, parentAgentId: null, provider: "yescode", cwd: root, title: null };
  const observation: AgentDeliveryObservation = { provider: "claude", sessionId: "native-id", messageId: "native-message",
    eventId: "native-event", lane: "socket", state: "held", reason: "no-mode-asserted", observedAt: 123 };
  const context = { signal: new AbortController().signal } as PluginHookContext;
  await handler({ agent, observation: { ...observation, lane: "stdin" } }, context);
  await handler({ agent, observation: { ...observation, eventId: undefined } }, context);
  await handler({ agent, observation: { ...observation, provider: "pi" } }, context);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  await handler({ agent, observation }, context);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { args: ["claude-mod"], cwd: root,
    input: { operation: "status", cwd: root, sessionId: "native-id", status: {
      provider: "claude", sessionId: "native-id", messageId: "native-message", eventId: "native-event", state: "held",
      observedAt: 123, reason: "no-mode-asserted",
    } } });
  await recordDeliveryStatus(root, { ...observation, state: "released", reason: null }, context.signal);
  assert.equal(JSON.parse(await readFile(output, "utf8")).input.status.reason, undefined);
  process.env.SQUARE_TEST_FAIL = "1";
  await assert.rejects(async () => handler({ agent, observation }, context), /Square native status recorder failed \(2\)/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(recordDeliveryStatus(root, observation, aborted.signal), { name: "AbortError" });
  cleanup();
  assert.equal(cleaned, true);
});
