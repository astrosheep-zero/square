import assert from "node:assert/strict";
import test from "node:test";
import { transformSquareMessage } from "../client/transform.ts";
import { squareHeadline, squareMessageSchema } from "../shared/message.ts";

type ToolRow = Parameters<typeof transformSquareMessage>[0]["item"];
const text = "\n```square-activity\n· /tmp/design.square · act/12\n● rei spoke your name (aoi)\n\n*把草图推过来*\n```\n· clipped — read it all:\nsquare --as aoi catch --id act/12\n";
const items: Parameters<typeof squareHeadline>[0][] = [
  { square: "design", actor: "rei", route: "mention", description: "rei spoke your name (aoi)" },
  { square: "design", actor: "rei", route: "reply", description: "rei answered you (aoi)" },
];
function row(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    type: "tool_call", callId: "custom/12", name: "square", status: "completed", error: null,
    detail: { type: "plain_text", text },
    metadata: { synthetic: true, customType: "square", details: { items } },
    ...overrides,
  } as ToolRow;
}
function project(item: ToolRow, phase: "streaming" | "complete" = "complete") {
  return transformSquareMessage({ item, phase });
}

test("Square live and history projection preserve exact content and renderer details", () => {
  const original = row();
  const before = structuredClone(original);
  const result = project(original);
  assert.deepEqual(result, project(original, "streaming"));
  assert.deepEqual(result, { items: [{
    type: "plugin", kind: "square-message", version: 1, data: { text, items },
  }] });
  assert.deepEqual(original, before, "projection never mutates source history");
  assert.deepEqual(squareMessageSchema.parse(result!.items[0].data), { text, items });
});

test("complete renderer text survives live/history projection and schema parsing without changing the model preview", () => {
  const fullText = `${text}\n${'complete body '.repeat(200)}\nFULL_BODY_TAIL`;
  const original = row({ metadata: { synthetic: true, customType: "square", details: { items, fullText } } });
  const before = structuredClone(original);
  const result = project(original)!;
  assert.deepEqual(result, project(original, "streaming"));
  const data = squareMessageSchema.parse(result.items[0].data);
  assert.equal(data.fullText, fullText);
  assert.equal(data.text, text);
  assert.deepEqual(original, before);
});

test("joining context and malformed details retain content under the generic heading", () => {
  for (const details of [undefined, { items: [] }, { items: [{ description: "missing square" }] }]) {
    const result = project(row({ metadata: { synthetic: true, customType: "square", details } }));
    assert.deepEqual(result?.items[0].data, { text });
  }
});

test("ordinary tools, unrelated custom messages, and unusable content stay untouched", () => {
  assert.equal(project(row({ metadata: undefined })), undefined);
  assert.equal(project(row({ metadata: { customType: "square" } })), undefined);
  assert.equal(project(row({ metadata: { synthetic: true, customType: "other" } })), undefined);
  assert.equal(project(row({ detail: { type: "unknown", input: "square", output: text } })), undefined);
  assert.equal(project(row({ detail: { type: "plain_text" } })), undefined);
});

test("headline is human-facing when actor and route are present, else falls back", () => {
  assert.equal(squareHeadline(items[0]), "rei spoke your name");
  assert.equal(squareHeadline(items[1]), "rei answered you");
  assert.equal(squareHeadline({ ...items[0], route: "attention" }), "rei spoke · you're listening");
  assert.equal(squareHeadline({ ...items[0], route: "bell" }), "rei rang the bell");
  // Messages from Square <0.3.71 carry only the agent-voice description.
  assert.equal(squareHeadline({ square: "design", description: "rei spoke your name (aoi)" }), "rei spoke your name (aoi)");
});
