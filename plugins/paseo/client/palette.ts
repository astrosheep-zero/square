import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Square's own courtyard palette: warm clay and fired terracotta, deliberately
 * no relative of notesoup's cream paper or pi-meantime's cold slate. Every
 * token here is opaque and self-contained — the card and Markdown never borrow
 * the host's surface ramp or accent, only its appearance (read from the host
 * ink) and its accentForeground, which paints text on top of an accent fill.
 */
const DARK = {
  surface0: "#181211", // inset / code
  surface1: "#211917", // card
  surface2: "#181211", // inset / code
  border: "#4a342d",
  foreground: "#f4e9e2",
  foregroundMuted: "#b39a8e",
  accent: "#ef8063", // plaza ■ / links
} as const;

const LIGHT = {
  surface0: "#e4d5cc",
  surface1: "#eee3dc", // clay plaster, not notesoup's #faf6eb cream
  surface2: "#e4d5cc",
  border: "#cdb4a7",
  foreground: "#30211c",
  foregroundMuted: "#80665b",
  accent: "#bd4f32",
} as const;

const VOICE = { dark: "#e5a064", light: "#a96332" } as const;

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
