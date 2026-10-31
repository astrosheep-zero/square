import type { PluginTheme } from "@getpaseo/plugin";
import { MARBLE_DARK, MARBLE_LIGHT } from "./marble.ts";

/**
 * Square's own courtyard palette: veinless honed stone (muted grey light, charcoal dark) and a
 * slate seal ■ — everything half a step down, the quiet card on the timeline, deliberately no relative of notesoup's warm parchment or
 * pi-meantime's neutral carbon. Every token here is opaque and self-contained — the card and
 * Markdown never borrow the host's surface ramp or accent, only its appearance
 * (read from the host ink) and its accentForeground, which paints text on top
 * of an accent fill.
 */
const DARK = {
  surface0: "#15171a", // inset / code
  surface1: "#1a1d20", // card (charcoal stone)
  surface2: "#15171a", // inset / code
  border: "#2b2f34",
  foreground: "#dde1e6",
  foregroundMuted: "#858b94",
  accent: "#8298ad", // plaza ■ / links
} as const;

const LIGHT = {
  surface0: "#e9ebee",
  surface1: "#f4f5f6", // card (grey stone)
  surface2: "#e9ebee",
  border: "#e0e2e5",
  foreground: "#2b2e33",
  foregroundMuted: "#90959c",
  accent: "#56687e",
} as const;

const TILE = 512;

/** Web-only surface: react-native-web passes these through as inline CSS. */
const STONE = {
  // A slab resting on the page: one darker cut along the bottom edge, a tight contact shadow, no sheen.
  dark: { image: `url(${MARBLE_DARK})`, edge: "#34393f", boxShadow: "0 1px 0 rgba(0,0,0,0.3), 0 4px 10px -6px rgba(0,0,0,0.55)", inlay: "inset 0 0 0 0.5px rgba(0,0,0,0.4)" },
  light: { image: `url(${MARBLE_LIGHT})`, edge: "#c9ccd1", boxShadow: "0 1px 0 rgba(24,26,30,0.04), 0 4px 10px -6px rgba(24,26,30,0.18)", inlay: "inset 0 0 0 0.5px rgba(0,0,0,0.26)" },
} as const;

export interface StoneSkin {
  /** Data-URI tile for a native `<Image resizeMode="repeat">` skin layer. */
  tile: { uri: string };
  /**
   * Oversized frame for the tile: inset negative by the seed's patch offset and
   * out by the complement, so the repeat fills the card from that patch at any
   * size (Fabric tiles via UIImageResizingModeTile; data URIs load via RCTDataRequestHandler).
   */
  frame: { left: number; top: number; right: number; bottom: number };
  /** The darker cut along the bottom edge. */
  edge: string;
  /** Contact shadow; Fabric parses the CSS string form. */
  boxShadow: string;
  /** Inset shadow setting the ■ into the stone. */
  inlay: string;
}

export interface SquarePalette {
  /** Complete theme for the card and its Markdown surfaces. */
  theme: PluginTheme;
  /** Marble card surface for the web host, cut from the tile at `seed`. */
  stone(seed: string): { backgroundImage: string; backgroundSize: string; backgroundPosition: string; borderBottomColor: string; boxShadow: string };
  /** The same slab for native hosts: tiled image skin, bottom cut, contact shadow, ■ inlay. */
  skin(seed: string): StoneSkin;
  /** Web-only: the ■ set into the stone. */
  inlay: { boxShadow: string };
}

/** Paseo theme colors are hex (#RGB or #RRGGBB). */
function brightness(hex: string): number {
  const rgb = hex.length === 4 ? hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(1, 7);
  return 0.299 * parseInt(rgb.slice(0, 2), 16)
    + 0.587 * parseInt(rgb.slice(2, 4), 16)
    + 0.114 * parseInt(rgb.slice(4, 6), 16);
}

/** Each card shows its own patch of the slab, so neighbours never repeat a vein. */
function patchOffset(seed: string): { x: number; y: number } {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return { x: (hash >>> 0) % TILE, y: (hash >>> 9) % TILE };
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
    stone: seed => {
      const { image, edge, boxShadow } = dark ? STONE.dark : STONE.light;
      const { x, y } = patchOffset(seed);
      return {
        backgroundImage: image,
        backgroundSize: `${TILE}px ${TILE}px`,
        backgroundPosition: `${-x}px ${-y}px`,
        borderBottomColor: edge,
        boxShadow,
      };
    },
    skin: seed => {
      const { edge, boxShadow, inlay } = dark ? STONE.dark : STONE.light;
      const { x, y } = patchOffset(seed);
      return {
        tile: { uri: dark ? MARBLE_DARK : MARBLE_LIGHT },
        frame: { left: -x, top: -y, right: -(TILE - x), bottom: -(TILE - y) },
        edge,
        boxShadow,
        inlay,
      };
    },
    inlay: { boxShadow: (dark ? STONE.dark : STONE.light).inlay },
  };
}
