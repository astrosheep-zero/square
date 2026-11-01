import assert from "node:assert/strict";
import test from "node:test";
import { squarePalette } from "../client/palette.ts";

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

test("the card is a square-edged matte slip: near-square corners, hairline ring, no shadow", () => {
  for (const theme of [lightTheme, darkTheme]) {
    const palette = squarePalette(theme);
    assert.equal(palette.card.borderRadius, 2);
    assert.equal(palette.card.boxShadow, "none", "the slip stays flat — the frosted rail beside it carries the depth");
    assert.equal(palette.seal.borderRadius, 0, "the ■ seal is a true square");
    assert.ok(palette.quote.borderLeftWidth <= 1 && palette.quote.paddingLeft < 15);
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
