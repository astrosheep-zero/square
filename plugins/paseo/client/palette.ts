import type { PluginTheme } from "@getpaseo/plugin";
import type { ViewStyle } from "react-native";
import { GRAIN_DARK, GRAIN_LIGHT } from "./grain.ts";

/**
 * Square's message card is a thin, matte mineral slip: a 4px corner, square seal ■,
 * weak static grain under a flat veil, and cut edges inside the plane. It has no
 * cast shadow, glass sheen or convex gradient; Meantime owns the richer quartz.
 */
const DARK = {
  surface0: "#1a1d21", // inset / code
  surface1: "#22262b", // card (cool mineral)
  surface2: "#1a1d21", // inset / code
  border: "#363d44",
  foreground: "#e4e6ea",
  foregroundMuted: "#858b94",
  accent: "#94a6b5", // plaza ■ / links
} as const;

const LIGHT = {
  surface0: "#e9edf0",
  surface1: "#f4f6f8", // card (cool mineral)
  surface2: "#e9edf0",
  border: "#dde2e7",
  foreground: "#1f2226",
  foregroundMuted: "#6b727b",
  accent: "#71869a",
} as const;

export interface SquarePalette {
  /** Complete theme for the card and its Markdown surfaces. */
  theme: PluginTheme;
  /** Thin slip: a hairline ring and only plane-internal cut edges, never a cast shadow. */
  card: { borderRadius: number; borderWidth: number; boxShadow: string };
  /** The square ■ seal, unrounded and flat. */
  seal: { borderRadius: number };
  /** Body and metadata tones derived from the slate theme. */
  body: string;
  action: string;
  code: string;
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

/** Web gets restrained static grain; native keeps the identical base and cut edges without url(). */
export function squareCardChrome(palette: SquarePalette, platform: "ios" | "android" | "web"): ViewStyle {
  const dark = brightness(palette.theme.colors.foreground) > brightness(palette.theme.colors.surface0);
  const veil = dark ? "rgba(34,38,43,0.76)" : "rgba(244,246,248,0.74)";
  return {
    backgroundColor: palette.theme.colors.surface1,
    borderColor: palette.theme.colors.border,
    borderWidth: palette.card.borderWidth,
    borderRadius: palette.card.borderRadius,
    boxShadow: palette.card.boxShadow,
    ...(platform === "web" ? {
      backgroundImage: `linear-gradient(${veil}, ${veil}), url(${dark ? GRAIN_DARK : GRAIN_LIGHT})`,
      backgroundSize: "100% 100%, 80px 80px",
    } : {}),
  };
}

/** Own speech is a quiet grey-lilac receipt: a solid, bounded surface without the incoming card's grain or cut edges. */
export function squareOutgoingChrome(theme: PluginTheme): ViewStyle {
  const dark = brightness(theme.colors.foreground) > brightness(theme.colors.surface0);
  return {
    backgroundColor: dark ? "#302a37" : "#eeedf2",
    borderColor: dark ? "#51485c" : "#d3d0db",
    borderWidth: 0.5,
    borderRadius: 4,
  };
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
    card: { borderRadius: 4, borderWidth: 0.5, boxShadow: dark
      ? "inset 0 0.5px 0 rgba(255,255,255,0.055), inset 0 -0.5px 0 rgba(0,0,0,0.30)"
      : "inset 0 0.5px 0 rgba(255,255,255,0.58), inset 0 -0.5px 0 rgba(70,85,100,0.065)" },
    seal: { borderRadius: 0 },
    body: mix(palette.foreground, palette.surface1, 0.9),
    action: mix(palette.foreground, palette.foregroundMuted, 0.45),
    code: mix(palette.accent, palette.foreground, 0.32),
    faint: mix(palette.foregroundMuted, palette.surface1, 0.7),
    name: mix(palette.accent, palette.foreground, 0.8),
    warm: theme.colors.statusWarning,
    // Every voice keeps a warm amber guide; direct reach burns brighter.
    directGuide: withAlpha(theme.colors.statusWarning, 0.9),
    inlineCode: withAlpha(palette.accent, 0.07),
    quote: { borderLeftWidth: 1, borderLeftColor: withAlpha(theme.colors.statusWarning, 0.45), paddingLeft: 10 },
  };
}
