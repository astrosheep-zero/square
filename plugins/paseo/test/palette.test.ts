import assert from "node:assert/strict";
import test from "node:test";
import { squarePalette } from "../client/palette.ts";

const lightTheme = { colors: {
  surface0: "#ffffff", surface1: "#f4f5f6", surface2: "#e9ebee", border: "#e0e2e5",
  foreground: "#111111", foregroundMuted: "#777777", accent: "#56687e", accentForeground: "#ffffff",
  statusSuccess: "#209c56", statusWarning: "#ce7c0e", statusDanger: "#da3c2e",
} };

test("native skin: repeatable data-URI tile with a per-seed patch offset", () => {
  const skin = squarePalette(lightTheme).skin("plaza act/1");
  assert.match(skin.tile.uri, /^data:image\/jpeg;base64,/);
  // The frame overshoots the card by exactly one tile on every axis, so
  // resizeMode="repeat" covers it no matter where the patch starts.
  assert.equal(-skin.frame.left - skin.frame.right, 512);
  assert.equal(-skin.frame.top - skin.frame.bottom, 512);
  assert.ok(skin.frame.left <= 0 && skin.frame.left > -512);
  assert.ok(skin.frame.top <= 0 && skin.frame.top > -512);
  assert.ok(skin.edge.length > 0 && skin.boxShadow.length > 0 && skin.inlay.length > 0);
});

test("skin offset is stable per seed and differs between cards", () => {
  const palette = squarePalette(lightTheme);
  assert.deepEqual(palette.skin("plaza act/1").frame, palette.skin("plaza act/1").frame);
  assert.notDeepEqual(
    [palette.skin("plaza act/1").frame.left, palette.skin("plaza act/1").frame.top],
    [palette.skin("plaza act/2").frame.left, palette.skin("plaza act/2").frame.top],
  );
});

test("web stone() keeps its CSS shape and shares the seed offset", () => {
  const stone = squarePalette(lightTheme).stone("plaza act/1");
  const skin = squarePalette(lightTheme).skin("plaza act/1");
  assert.match(stone.backgroundImage, /^url\(data:image\/jpeg;base64,/);
  assert.equal(stone.backgroundSize, "512px 512px");
  assert.equal(stone.backgroundPosition, `${skin.frame.left}px ${skin.frame.top}px`);
});
