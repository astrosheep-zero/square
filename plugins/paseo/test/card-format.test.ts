import assert from "node:assert/strict";
import test from "node:test";
import { cardReferences, reachLabel, timeLabel } from "../shared/card-format.ts";
import { isCardPresentation, type CardPresentation } from "../shared/card-presentation.ts";
import { wholeLineHeight } from "../shared/text-layout.ts";

const presentation: CardPresentation = { kind: "presentation", origin: "design", at: 0, reach: "attention", body: "hi" };

test("presentations reject malformed landing time or reach, yet accept cards that predate them", () => {
  assert.ok(isCardPresentation(presentation));
  assert.ok(isCardPresentation({ ...presentation, at: undefined, reach: undefined }));
  for (const changed of [{ at: NaN }, { at: Infinity }, { reach: "other" }]) {
    assert.equal(isCardPresentation({ ...presentation, ...changed }), false);
  }
});

test("only direct reach has a label", () => {
  assert.deepEqual(["mention", "reply", "bell", "attention"].map(reach => reachLabel(reach as CardPresentation["reach"])),
    ["@you", "reply", "bell", undefined]);
});

test("time labels follow local calendar days across month boundaries", () => {
  const now = new Date(2026, 10, 1, 9, 30).getTime();
  const today = new Date(2026, 10, 1, 9, 14).getTime();
  const yesterday = new Date(2026, 9, 31, 22, 40).getTime();
  const older = new Date(2026, 9, 30, 22, 40).getTime();
  assert.equal(timeLabel(today, now), "09:14");
  assert.equal(timeLabel(yesterday, now), "yesterday 22:40");
  assert.equal(timeLabel(older, now), "Oct 30 22:40");
  assert.equal(timeLabel(yesterday, now, true), "yest 22:40");
  assert.equal(timeLabel(older, now, true), "10/30 22:40");
});

test("references merge contiguous activities without implying gaps or mixing origins", () => {
  const refs = (origin: string, values: string[]) => values.map(ref => ({ ...presentation, origin, ref }));
  assert.equal(cardReferences(refs("design", ["act/14", "act/15", "act/16", "act/20", "job/3"])), "act/14–16, act/20, job/3");
  assert.equal(cardReferences([...refs("design", ["act/14", "act/15"]), ...refs("jobs", ["act/16"])]),
    "design act/14–15, jobs act/16");
});

test("clipping ends after the last whole text line, even when the limit falls in whitespace", () => {
  const lines = [{ top: 0, height: 20 }, { top: 27, height: 18 }, { top: 70, height: 20 }, { top: 100, height: 20 }];
  assert.equal(wholeLineHeight(lines, 80), 45);
});
