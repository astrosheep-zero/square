import assert from "node:assert/strict";
import test from "node:test";
import { transformSquareMessage } from "../client/transform.ts";
import { OUTPUT_DISPLAY_MAX_CHARS, squareMessageSchema, type PresentationItem } from "../shared/message.ts";

type ToolRow = Parameters<typeof transformSquareMessage>[0]["item"];
const text = "Only a clipped model preview, not the renderer's full bodies.";
const quotedTags = '<square-activity square="pretend" id="act/999">\nnot another message\n</square-activity>';
const items: PresentationItem[] = [
  { kind: "presentation", at: 1, reach: "attention", origin: "jobs", author: "worker", ref: "job/12", body: `Direct **source**\n\n${quotedTags}` },
  { kind: "presentation", at: 2, reach: "bell", origin: "design", author: "rei", ref: "act/15", body: "Last **bell** body" },
];
function row(details: unknown = { items }): ToolRow {
  return {
    type: "tool_call", callId: "custom/12", name: "square", status: "completed", error: null,
    detail: { type: "plain_text", text },
    metadata: { synthetic: true, customType: "square", details },
  } as ToolRow;
}
function project(item: ToolRow, phase: "streaming" | "complete" = "complete") {
  return transformSquareMessage({ item, phase });
}
function data(item: ToolRow) {
  return squareMessageSchema.parse(project(item)!.items[0].data);
}

test("generic producer details retain attribution, reach, landing time and full bodies in live/history cards", () => {
  const original = row();
  const before = structuredClone(original);
  assert.deepEqual(project(original), project(original, "streaming"));
  const displayed = data(original);
  assert.ok("items" in displayed);
  assert.deepEqual(displayed.items, items);
  assert.deepEqual(original, before);
});

test("generic details with optional attribution and plain markdown share a batch", () => {
  const notice = { kind: "presentation", at: 3, reach: "mention", origin: "other producer", body: "full **notice**" };
  const plain = { text: "External **markdown**\n" + quotedTags };
  const displayed = data(row({ items: [items[0], plain, notice] }));
  assert.ok("items" in displayed);
  assert.deepEqual(displayed.items, [items[0], plain, notice]);
});

test("long bodies share one bounded display budget without changing source", () => {
  const long = items.map((item, index) => ({ ...item,
    body: `START ${index}\n${"🦈".repeat(OUTPUT_DISPLAY_MAX_CHARS)}\nEND ${index}`,
  }));
  const original = row({ items: long });
  const before = structuredClone(original);
  const displayed = data(original);
  assert.ok("items" in displayed);
  const bodies = displayed.items.map(item => {
    assert.ok("body" in item);
    assert.equal(Buffer.from(item.body).toString("utf8"), item.body);
    return item;
  });
  assert.ok(bodies.reduce((sum, item) => sum + item.body.length, 0) <= OUTPUT_DISPLAY_MAX_CHARS);
  for (const [index, item] of bodies.entries()) {
    assert.equal(item.author, long[index]!.author);
    assert.equal(item.ref, long[index]!.ref);
    assert.ok(item.body.startsWith(`START ${index}\n`) && item.body.endsWith(`\nEND ${index}`));
  }
  assert.deepEqual(original, before);
});

test("missing or malformed details fall back to raw text without inferring attribution", () => {
  for (const details of [null, { items: [] }, { items: [{ ...items[0], origin: undefined }] }, { items: [{ ...items[0], body: 7 }] }]) {
    assert.deepEqual(data(row(details)), { text });
  }
});

test("ordinary tools, unrelated custom messages, and unusable content stay untouched", () => {
  assert.equal(project({ ...row(), metadata: undefined }), undefined);
  assert.equal(project({ ...row(), metadata: { customType: "square" } }), undefined);
  assert.equal(project({ ...row(), metadata: { synthetic: true, customType: "other" } }), undefined);
  assert.equal(project({ ...row(), detail: { type: "unknown", input: "square", output: text } }), undefined);
  assert.equal(project({ ...row(), detail: { type: "plain_text" } }), undefined);
});
