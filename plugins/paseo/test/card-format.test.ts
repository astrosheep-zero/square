import assert from "node:assert/strict";
import test from "node:test";
import { activityLabel, isDirectCardReach, shortOrigin, timeLabel } from "../shared/card-format.ts";
import { isCardPresentation, type CardPresentation } from "../shared/card-presentation.ts";

const presentation: CardPresentation = { kind: "presentation", origin: "design", at: 0, reach: "attention", body: "hi" };

test("presentations reject malformed landing time or reach, yet accept cards that predate them", () => {
  assert.ok(isCardPresentation(presentation));
  assert.ok(isCardPresentation({ ...presentation, at: undefined, reach: undefined }));
  assert.ok(isCardPresentation({ ...presentation, replyTo: "kei", label: "custom event" }));
  for (const changed of [{ at: NaN }, { at: Infinity }, { reach: "other" }, { replyTo: 14 }, { label: 42 }]) {
    assert.equal(isCardPresentation({ ...presentation, ...changed }), false);
  }
});

test("typed reach decides directness independently of producer labels", () => {
  assert.deepEqual(["mention", "reply", "bell", "attention", undefined].map(reach => isDirectCardReach(reach as CardPresentation["reach"] | undefined)),
    [true, true, true, false, false]);
});

test("producer labels are plain text independent of directed reach; absent labels stay absent", () => {
  assert.deepEqual([undefined, "attention", "mention", "reply", "bell"].map(reach => activityLabel(reach as CardPresentation["reach"])),
    ["", "", "mention", "reply", "bell"]);
  assert.equal(activityLabel("attention", undefined, undefined, "express"), "express");
  assert.equal(activityLabel(undefined, undefined, undefined, "custom event"), "custom event");
  assert.equal(activityLabel("mention", "faye", undefined, "update"), "update · → @faye");
  assert.equal(activityLabel("reply", "faye", "kei", "done"), "done · reply → kei");
  assert.equal(activityLabel("bell", undefined, undefined, "published"), "published · bell");
  assert.equal(activityLabel("mention", "faye"), "→ @faye");
  assert.equal(activityLabel("reply", "faye", "kei"), "reply → kei");
  assert.equal(activityLabel("reply", "faye"), "reply");
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

test("path-like origins show only their meaningful tail", () => {
  assert.equal(shortOrigin("~/Developer/bio/.square/PUBLIC.square"), "PUBLIC.square");
  assert.equal(shortOrigin("design"), "design");
});
