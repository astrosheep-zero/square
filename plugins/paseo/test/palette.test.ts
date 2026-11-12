import assert from "node:assert/strict";
import test from "node:test";
import { squareCardChrome, squarePalette } from "../client/palette.ts";

const lightTheme = { colors: {
  surface0: "#ffffff", surface1: "#f4f5f6", surface2: "#e9ebee", border: "#e0e2e5",
  foreground: "#111111", foregroundMuted: "#777777", accent: "#56687e", accentForeground: "#ffffff",
  statusSuccess: "#209c56", statusWarning: "#ce7c0e", statusDanger: "#da3c2e",
} };
const darkTheme = { colors: {
  surface0: "#101215", surface1: "#1a1d20", surface2: "#15171a", border: "#2b2f34",
  foreground: "#e4e6ea", foregroundMuted: "#858b94", accent: "#8298ad", accentForeground: "#101215",
  statusSuccess: "#7fb26a", statusWarning: "#e9b45a", statusDanger: "#ef7d6b",
} };

test("the mineral slip keeps only plane-internal cut edges and a square seal", () => {
  for (const theme of [lightTheme, darkTheme]) {
    const palette = squarePalette(theme);
    const layers = palette.card.boxShadow.replace(/rgba\([^)]*\)/g, "color").split(",").map(layer => layer.trim());
    assert.ok(layers.every(layer => layer.startsWith("inset ")), "nothing lifts off the timeline plane");
    assert.equal(palette.seal.borderRadius, 0, "the ■ seal is a true square");
    assert.ok(palette.quote.borderLeftWidth <= 1 && palette.quote.paddingLeft < 15);
  }
});

test("web grain has a native matte fallback with the same base and cut edges", () => {
  for (const theme of [lightTheme, darkTheme]) {
    const palette = squarePalette(theme);
    const web = squareCardChrome(palette, "web") as Record<string, unknown>;
    const ios = squareCardChrome(palette, "ios") as Record<string, unknown>;
    assert.ok(String(web.backgroundImage).includes("url(data:image/png;base64,"));
    assert.ok(!("backgroundImage" in ios) && !("experimental_backgroundImage" in ios));
    assert.equal(ios.backgroundColor, web.backgroundColor);
    assert.equal(ios.boxShadow, web.boxShadow);
  }
});

test("light and dark slips keep their own matte surfaces and quote guides", () => {
  const light = squarePalette(lightTheme);
  const dark = squarePalette(darkTheme);
  assert.notEqual(light.theme.colors.surface1, dark.theme.colors.surface1);
  assert.notEqual(light.quote.borderLeftColor, dark.quote.borderLeftColor);
  assert.equal(light.theme.colors.accentForeground, lightTheme.colors.accentForeground);
  assert.equal(dark.theme.colors.statusSuccess, darkTheme.colors.statusSuccess);
});
