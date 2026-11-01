import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Square's message card is a matte slate slip in one family with the timeline's
 * meantime rail and notesoup paper: the shared 4px corner, a square seal ■, a thin quote
 * guide under the header. No glass sheen, no stone texture, no bottom cut —
 * the card earns its identity from colour and the seal, not decoration.
 */
const DARK = {
  surface0: "#14161a", // inset / code
  surface1: "#252a2e", // card (matte slate paper)
  surface2: "#14161a", // inset / code
  border: "#3a4249",
  foreground: "#d9dce1",
  foregroundMuted: "#858b94",
  accent: "#94a6b5", // plaza ■ / links
} as const;

const LIGHT = {
  surface0: "#f4f5f7",
  surface1: "#edf0f2", // card (matte slate paper)
  surface2: "#f4f5f7",
  border: "#ced5db",
  foreground: "#2b2e33",
  foregroundMuted: "#858b94",
  accent: "#71869a",
} as const;

export interface SquarePalette {
  /** Complete theme for the card and its Markdown surfaces. */
  theme: PluginTheme;
  /** Flat slip: a hairline ring and no shadow, so the frosted rail beside it can carry the depth. */
  card: { borderRadius: number; borderWidth: number; boxShadow: string };
  /** The square ■ seal, unrounded and flat. */
  seal: { borderRadius: number };
  /** The thin quote guide under the header. */
  quote: { borderLeftWidth: number; borderLeftColor: string; paddingLeft: number };
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
    card: { borderRadius: 4, borderWidth: 0.5, boxShadow: "none" },
    seal: { borderRadius: 0 },
    quote: { borderLeftWidth: 1, borderLeftColor: dark ? "#45535e" : "#c2cdd5", paddingLeft: 9 },
  };
}
