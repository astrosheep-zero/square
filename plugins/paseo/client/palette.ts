import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Square's message card is a matte slate slip in one family with the timeline's
 * meantime rail and notesoup paper: the shared 4px corner, a square seal ■, a thin quote
 * guide under the header. No glass sheen, no stone texture, no bottom cut —
 * the card earns its identity from colour and the seal, not decoration.
 */
const DARK = {
  surface0: "#1a1d21", // inset / code
  surface1: "#252a2e", // card (matte slate paper)
  surface2: "#1a1d21", // inset / code
  border: "#363d44",
  foreground: "#e4e6ea",
  foregroundMuted: "#858b94",
  accent: "#94a6b5", // plaza ■ / links
} as const;

const LIGHT = {
  surface0: "#e9edf0",
  surface1: "#f6f7f9", // card (matte slate paper)
  surface2: "#e9edf0",
  border: "#dde2e7",
  foreground: "#1f2226",
  foregroundMuted: "#6b727b",
  accent: "#71869a",
} as const;

export interface SquarePalette {
  /** Complete theme for the card and its Markdown surfaces. */
  theme: PluginTheme;
  /** Flat slip: a hairline ring and no shadow, so the frosted rail beside it can carry the depth. */
  card: { borderRadius: number; borderWidth: number; boxShadow: string };
  /** The square ■ seal, unrounded and flat. */
  seal: { borderRadius: number };
  /** Body and metadata tones derived from the slate theme. */
  body: string;
  faint: string;
  name: string;
  warm: string;
  directGuide: string;
  inlineCode: string;
  /** The thin message guide under the header. */
  quote: { borderLeftWidth: number; borderLeftColor: string; paddingLeft: number };
}

/** Paseo theme colors are hex (#RGB or #RRGGBB). */
function brightness(hex: string): number {
  const rgb = hex.length === 4 ? hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(1, 7);
  return 0.299 * parseInt(rgb.slice(0, 2), 16)
    + 0.587 * parseInt(rgb.slice(2, 4), 16)
    + 0.114 * parseInt(rgb.slice(4, 6), 16);
}

export function withAlpha(hex: string, opacity: number): string {
  const rgb = hex.length === 4 ? "#" + hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(0, 7);
  return `${rgb}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
}

function mix(first: string, second: string, amount: number): string {
  const rgb = (hex: string) => (hex.length === 4 ? hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(1, 7));
  const a = rgb(first), b = rgb(second);
  return "#" + [0, 2, 4].map(offset => Math.round(parseInt(a.slice(offset, offset + 2), 16) * amount
    + parseInt(b.slice(offset, offset + 2), 16) * (1 - amount)).toString(16).padStart(2, "0")).join("");
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
    body: mix(palette.foreground, palette.surface1, 0.9),
    faint: mix(palette.foregroundMuted, palette.surface1, 0.7),
    name: mix(palette.accent, palette.foreground, 0.8),
    warm: theme.colors.statusWarning,
    directGuide: withAlpha(theme.colors.statusWarning, 0.6),
    inlineCode: withAlpha(palette.accent, 0.1),
    quote: { borderLeftWidth: 1, borderLeftColor: withAlpha(palette.accent, 0.28), paddingLeft: 10 },
  };
}
