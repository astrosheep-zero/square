import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Square's own courtyard palette: cool pewter slate and a cold blue voice,
 * deliberately no relative of notesoup's warm parchment or pi-meantime's
 * neutral carbon. Every token here is opaque and self-contained — the card and
 * Markdown never borrow the host's surface ramp or accent, only its appearance
 * (read from the host ink) and its accentForeground, which paints text on top
 * of an accent fill.
 */
const DARK = {
  surface0: "#121519", // inset / code
  surface1: "#171b20", // card
  surface2: "#121519", // inset / code
  border: "#262d36",
  foreground: "#e6ebf2",
  foregroundMuted: "#7d8999",
  accent: "#60a5fa", // plaza ■ / links
} as const;

const LIGHT = {
  surface0: "#e8edf3",
  surface1: "#f3f6fa", // pewter slate, not notesoup's warm parchment
  surface2: "#e8edf3",
  border: "#d5dee8",
  foreground: "#141b24",
  foregroundMuted: "#64748b",
  accent: "#2563eb",
} as const;

const VOICE = { dark: "#93c5fd", light: "#3b82f6" } as const;

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
