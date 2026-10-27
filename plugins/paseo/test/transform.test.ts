import assert from "node:assert/strict";
import test from "node:test";
import { transformSquareMessage } from "../client/transform.ts";
import { COLLAPSED_PREVIEW_MAX_CHARS, OUTPUT_DISPLAY_MAX_CHARS, outputPreview, parseSquareBlocks, squareHeadline, squareMessageSchema } from "../shared/message.ts";

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

test("complete renderer text survives live/history projection as one bounded body", () => {
  const fullText = `${text}\n${'complete body '.repeat(200)}\nFULL_BODY_TAIL`;
  const original = row({ metadata: { synthetic: true, customType: "square", details: { items, fullText } } });
  const before = structuredClone(original);
  const result = project(original)!;
  assert.deepEqual(result, project(original, "streaming"));
  const projected = result.items[0].data as Record<string, unknown>;
  assert.equal(projected.text, outputPreview(fullText));
  assert.notEqual(projected.text, text);
  assert.equal(projected.fullText, undefined);
  assert.equal(squareMessageSchema.parse(projected).text, projected.text);
  assert.deepEqual(original, before);
});

test("oversized messages have bounded head/tail displays and short collapsed previews, not changed history", () => {
  const body = "START\n" + "🦈".repeat(500_000) + "\nEND";
  const original = row({ detail: { type: "plain_text", text: body },
    metadata: { synthetic: true, customType: "square", details: { fullText: body, items: [{ ...items[0], preview: body }] } } });
  const before = JSON.stringify(original);
  const data = squareMessageSchema.parse(project(original)!.items[0].data);
  for (const [preview, limit] of [[data.text, OUTPUT_DISPLAY_MAX_CHARS],
    [data.items![0]!.preview!, COLLAPSED_PREVIEW_MAX_CHARS]] as const) {
    assert.ok(preview.length <= limit);
    assert.ok(preview.startsWith("START\n") && preview.endsWith("\nEND"));
    assert.match(preview, /middle is hidden/);
    assert.equal(Buffer.from(preview).toString("utf8"), preview);
  }
  assert.equal(JSON.stringify(original), before);
});

test("only the latest item preview is bounded during projection and source stays untouched", () => {
  const body = (label: string) => `START ${label}\n${"🦈".repeat(COLLAPSED_PREVIEW_MAX_CHARS)}\nEND ${label}`;
  const earlier = { ...items[0], preview: body("EARLIER") };
  const latest = { ...items[1], preview: body("LATEST") };
  const original = row({ metadata: { synthetic: true, customType: "square", details: { items: [earlier, latest] } } });
  const before = structuredClone(original);
  const data = squareMessageSchema.parse(project(original)!.items[0].data);
  assert.equal(data.items![0]!.preview, earlier.preview);
  const drawn = data.items![1]!.preview!;
  assert.ok(drawn.length <= COLLAPSED_PREVIEW_MAX_CHARS);
  assert.ok(drawn.startsWith("START LATEST\n") && drawn.endsWith("\nEND LATEST"));
  assert.match(drawn, /middle is hidden/);
  assert.equal(Buffer.from(drawn).toString("utf8"), drawn);
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

test("square activity envelopes take their route line from attributes or from the first inner line", () => {
  const attributed = [
    "before the card",
    '<square-activity square="design" as="aoi" id="act/12">',
    "● rei spoke your name",
    "",
    "*把草图推过来*",
    "</square-activity>",
  ].join("\n");
  assert.deepEqual(parseSquareBlocks(attributed), [
    { body: "before the card" },
    { meta: "· design · aoi · act/12", actor: "● rei spoke your name", body: "*把草图推过来*" },
  ]);

  const attributeLess = [
    "<square-activity>",
    "· /tmp/design.square · act/12",
    "● rei spoke your name",
    "",
    "*把草图推过来*",
    "</square-activity>",
  ].join("\n");
  assert.deepEqual(parseSquareBlocks(attributeLess), [
    { meta: "· /tmp/design.square · act/12", actor: "● rei spoke your name", body: "*把草图推过来*" },
  ]);

  // A bare activity without a route line keeps its first line as the actor, and loose text stays a body.
  assert.deepEqual(parseSquareBlocks("<square-activity>\n● rei spoke\nhi\n</square-activity>\n尾"), [
    { meta: undefined, actor: "● rei spoke", body: "hi" },
    { body: "尾" },
  ]);
  assert.deepEqual(parseSquareBlocks("just words"), [{ body: "just words" }]);
});
