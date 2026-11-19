import { useMemo } from "react";
import { Text, View } from "react-native";
import { withAlpha, type SquarePalette } from "./palette";
import { lexer } from "marked";
import { renderBlocks } from "./markdown-core";
import type { Typography } from "./typography";

function makeStyles(palette: SquarePalette, type: Typography) {
  const colors = palette.theme.colors;
  const hairline = { borderColor: colors.border, borderWidth: 0.5 };
  return {
    block: { gap: 8 },
    text: { ...type.body, color: palette.body },
    heading: { ...type.base, fontWeight: "600" as const, color: colors.foreground, letterSpacing: -0.1 },
    lead: { ...type.base, color: palette.name, fontWeight: "600" as const },
    strong: { fontWeight: "600" as const, color: colors.foreground },
    // Stage actions (*leans back*) step back half a shade from spoken lines, especially in CJK where italics barely slant.
    em: { fontStyle: "italic" as const, color: palette.action },
    del: { color: colors.foregroundMuted, textDecorationLine: "line-through" as const },
    link: { color: colors.accent, textDecorationLine: "underline" as const, textDecorationColor: withAlpha(colors.accent, 0.4) },
    // No borderRadius here: a rounded background on a nested Text makes iOS Fabric paint a slab from the block origin when a codespan wraps.
    inlineCode: { ...type.inlineCode, color: palette.code, backgroundColor: palette.inlineCode },
    codeBlock: { ...hairline, backgroundColor: colors.surface0, borderRadius: 4 },
    codeContent: { paddingHorizontal: 10, paddingVertical: 8 },
    codeText: { ...type.code, color: colors.foreground },
    // Subordinate to the card's outer 1px message guide: a 1px hairline and a faint inset wash.
    quote: { borderLeftWidth: 1, borderLeftColor: colors.border, backgroundColor: withAlpha(colors.surface0, 0.55),
      paddingLeft: 9, paddingRight: 8, paddingVertical: 4, borderRadius: 2, gap: 6 },
    quoteText: { color: colors.foregroundMuted },
    separator: { height: 0.5, backgroundColor: colors.border, marginVertical: 4 },
    list: { gap: 4 },
    listRow: { flexDirection: "row" as const },
    // A fixed gutter gives wrapped lines a hanging indent; ordinals align on their right edge.
    bullet: { ...type.body, color: colors.foregroundMuted, minWidth: 18, paddingRight: 6,
      textAlign: "right" as const, fontVariant: ["tabular-nums" as const] },
    listItem: { flex: 1, gap: 4 },
    table: { ...hairline, borderRadius: 4, overflow: "hidden" as const },
    tableHead: { backgroundColor: colors.surface0 },
    tableRow: { flexDirection: "row" as const, borderTopWidth: 0.5, borderTopColor: colors.border },
    tableCell: { paddingVertical: 4, paddingHorizontal: 8 },
  };
}

/** Speaker, action and time form the left group; the message's own reference stands alone at right. */
export function SquareMarkdownBody({ text, palette, type, author, reach, reachColor, reference, time, openLinks = true }: {
  text: string;
  palette: SquarePalette;
  type: Typography;
  author?: string;
  reach?: string;
  reachColor?: string;
  reference?: string;
  time?: string;
  openLinks?: boolean;
}) {
  const styles = useMemo(() => makeStyles(palette, type), [palette, type]);
  const tokens = useMemo(() => lexer(text), [text]);
  const hasByline = author !== undefined || reach !== undefined || reference !== undefined || time !== undefined;
  const meta = type.sm;
  return <View>
    {hasByline && <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 17, marginBottom: 3 }}>
      <Text numberOfLines={1} style={{ ...meta, flex: 1, minWidth: 0 }}>
        {author !== undefined && <Text style={styles.lead}>{author}</Text>}
        {reach !== undefined && <Text style={{ fontWeight: "500", color: reachColor ?? palette.warm }}>{author === undefined ? "" : " "}{reach}</Text>}
        {time !== undefined && <Text style={{ color: palette.faint, fontVariant: ["tabular-nums"] }}>
          {author !== undefined || reach !== undefined ? "  " : ""}{time}
        </Text>}
      </Text>
      {reference !== undefined && <Text numberOfLines={1}
        style={{ ...meta, color: palette.faint, fontVariant: ["tabular-nums"], textAlign: "right", flexShrink: 0 }}>
        {reference}
      </Text>}
    </View>}
    <View style={styles.block}>
      {renderBlocks(tokens, styles, "body", undefined, openLinks)}
    </View>
  </View>;
}
