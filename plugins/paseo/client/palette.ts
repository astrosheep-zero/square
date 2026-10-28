import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Square's own courtyard palette: Carrara marble (grey-white stone with a
 * slate-blue vein), deliberately no relative of notesoup's warm parchment or
 * pi-meantime's neutral carbon. Every token here is opaque and self-contained — the card and
 * Markdown never borrow the host's surface ramp or accent, only its appearance
 * (read from the host ink) and its accentForeground, which paints text on top
 * of an accent fill.
 */
const DARK = {
  surface0: "#14171b", // inset / code
  surface1: "#1c2126", // card
  surface2: "#14171b", // inset / code
  border: "#2e353d",
  foreground: "#e8edf3",
  foregroundMuted: "#8b96a3",
  accent: "#8ea8c3", // plaza ■ / links
} as const;

const LIGHT = {
  surface0: "#e7ecf1",
  surface1: "#f2f5f9", // cool marble white
  surface2: "#e7ecf1",
  border: "#d2dae3",
  foreground: "#181d24",
  foregroundMuted: "#67737f",
  accent: "#4b6582",
} as const;

const VOICE = { dark: "#8b96a3", light: "#67737f" } as const; // grey: only the ■ carries colour

export interface SquarePalette {
  /** Complete theme for the card and its Markdown surfaces. */
  theme: PluginTheme;
  /** The filled ● speaker dot; the hollow ○ keeps the muted ink instead. */
  voice: string;
}

/** Paseo theme colors are hex (#RGB or #RRGGBB). */
function brightness(hex: string): number {
  const rgb = hex.length === 4 ? hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(1, 7);
  return 0.299 * parseInt(rgb.slice(0, 2), 16)
    + 0.587 * parseInt(rgb.slice(2, 4), 16)
    + 0.114 * parseInt(rgb.slice(4, 6), 16);
}

export function squarePalette(theme: PluginTheme): SquarePalette {
  // The SDK exposes colors, not appearance. Use the host theme, never the OS color scheme.
  const dark = brightness(theme.colors.foreground) > brightness(theme.colors.surface0);
  const palette = dark ? DARK : LIGHT;
  return {
    theme: { colors: {
      ...palette,
      accentForeground: theme.colors.accentForeground,
      statusSuccess: theme.colors.statusSuccess,
      statusWarning: theme.colors.statusWarning,
      statusDanger: theme.colors.statusDanger,
    } },
    voice: dark ? VOICE.dark : VOICE.light,
  };
}
