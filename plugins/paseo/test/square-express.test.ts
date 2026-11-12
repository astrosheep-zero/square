import assert from "node:assert/strict";
import test from "node:test";
import { outgoingActivityLabel, parseSquareExpress } from "../shared/square-express.ts";
import { squareMessageSchema } from "../shared/message.ts";

const input = { location: "/work/design.square", as: "rei", body: "**hello** @aoi",
  mentions: ["aoi", "kei"], reply: "act/14", bell: false, force: true, noMention: true, noWait: true };
const row = (name = "square_express", status = "running") => ({
  type: "tool_call", name, status,
  detail: { type: "unknown", input, output: "act/999, failed, or any other output" },
});

test("exact Pi and confirmed MCP tool names preserve speech input and map timeline status", () => {
  for (const name of ["square_express", "mcp__square__express", "square.express"]) {
    for (const [status, expected] of [["running", "running"], ["completed", "ok"], ["failed", "error"]]) {
      const item = row(name, status);
      const before = structuredClone(item);
      const outgoing = parseSquareExpress(item);
      assert.deepEqual(outgoing, { location: input.location, as: "rei", body: input.body,
        mentions: ["aoi", "kei"], reply: "act/14", bell: false, status: expected });
      assert.deepEqual(squareMessageSchema.parse({ outgoing }), { outgoing });
      assert.deepEqual(item, before);
    }
  }
});

test("unrelated tools, invalid input, other detail shapes and unknown statuses stay native", () => {
  for (const name of ["codemode", "square_perceive", "express", "other_square_express", "mcp__other__express"]) {
    assert.equal(parseSquareExpress(row(name)), undefined);
  }
  for (const bad of [null, {}, { body: "hi" }, { location: "design" }, { ...input, body: 1 },
    { ...input, location: 1 }, { ...input, as: 1 }, { ...input, mentions: "aoi" },
    { ...input, mentions: [1] }, { ...input, reply: 14 }, { ...input, bell: "yes" }]) {
    assert.equal(parseSquareExpress({ ...row(), detail: { type: "unknown", input: bad } }), undefined);
  }
  assert.equal(parseSquareExpress({ ...row(), type: "assistant_message" }), undefined);
  assert.equal(parseSquareExpress({ ...row(), detail: { type: "plain_text", text: "hello" } }), undefined);
  assert.equal(parseSquareExpress(row("square_express", "queued")), undefined);
});

test("optional attribution and actions come only from input, with no reference or result inference", () => {
  const outgoing = parseSquareExpress({ ...row("square_express", "completed"),
    detail: { type: "unknown", input: { location: "design", body: "" }, output: "✕ act/999 from rei @aoi" } });
  assert.deepEqual(outgoing, { location: "design", body: "", status: "ok" });
  assert.equal(outgoingActivityLabel(outgoing!), "express");
  const base = { location: "design", body: "hello", status: "running" as const };
  assert.equal(outgoingActivityLabel({ ...base, as: "rei", mentions: ["aoi", "kei"] }), "→ @aoi, @kei");
  assert.equal(outgoingActivityLabel({ ...base, mentions: ["rei"] }), "@rei");
  assert.equal(outgoingActivityLabel({ ...base, mentions: ["aoi", "kei"] }), "@aoi, @kei");
  assert.equal(outgoingActivityLabel({ ...base, reply: "act/14" }), "reply act/14");
  assert.equal(outgoingActivityLabel({ ...base, bell: true }), "bell");
  assert.equal(outgoingActivityLabel({ ...base, mentions: ["aoi"], reply: "act/14" }), "@aoi · reply act/14");
  assert.equal(squareMessageSchema.safeParse({ outgoing: { ...base, status: "completed" } }).success, false);
});
