import { useMemo, type ReactNode } from "react";
import { Platform, ScrollView, Text, View, type TextStyle } from "react-native";
import { withAlpha, type SquarePalette } from "./palette";
import { Lexer, lexer, type Token, type Tokens } from "marked";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

function makeStyles(palette: SquarePalette) {
  const colors = palette.theme.colors;
  const hairline = { borderColor: colors.border, borderWidth: 0.5 };
  return {
    block: { gap: 8 },
    text: { color: palette.body, fontSize: 13.5, lineHeight: 20 },
    // Size carries only the top two levels; deeper headings are weight alone, so a card never shouts.
    heading: { fontWeight: "600" as const, color: colors.foreground, letterSpacing: -0.1 },
    headingSizes: [{ fontSize: 15.5, lineHeight: 22 }, { fontSize: 14.5, lineHeight: 21 }] as TextStyle[],
    lead: { color: palette.name, fontWeight: "600" as const },
    strong: { fontWeight: "600" as const, color: colors.foreground },
    em: { fontStyle: "italic" as const },
    del: { color: colors.foregroundMuted, textDecorationLine: "line-through" as const },
    link: { color: colors.accent, textDecorationLine: "underline" as const, textDecorationColor: withAlpha(colors.accent, 0.4) },
    inlineCode: { fontFamily: MONO, fontSize: 12, color: colors.foreground, backgroundColor: palette.inlineCode, borderRadius: 3 },
    codeBlock: { ...hairline, backgroundColor: colors.surface0, borderRadius: 4 },
    codeContent: { paddingHorizontal: 10, paddingVertical: 8 },
    codeText: { fontFamily: MONO, fontSize: 12, lineHeight: 18, color: colors.foreground },
    quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 10, gap: 8 },
    quoteText: { color: colors.foregroundMuted },
    separator: { height: 0.5, backgroundColor: colors.border, marginVertical: 4 },
    list: { gap: 4 },
    listRow: { flexDirection: "row" as const },
    // A fixed gutter gives wrapped lines a hanging indent; ordinals align on their right edge.
    bullet: { color: colors.foregroundMuted, fontSize: 13.5, lineHeight: 20, minWidth: 18, paddingRight: 6,
      textAlign: "right" as const, fontVariant: ["tabular-nums" as const] },
    listItem: { flex: 1, gap: 4 },
    table: { ...hairline, borderRadius: 4, overflow: "hidden" as const },
    tableHead: { backgroundColor: colors.surface0 },
    tableRow: { flexDirection: "row" as const, borderTopWidth: 0.5, borderTopColor: colors.border },
    tableCell: { paddingVertical: 4, paddingHorizontal: 8 },
  };
}

type Styles = ReturnType<typeof makeStyles>;

/** Children of a token, if it has any: `Token` is a union, so the optional field needs one cast. */
const children = (node: Token | { tokens?: Token[] }): Token[] => (node as { tokens?: Token[] }).tokens ?? [];

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" };
const unescape = (text: string): string => text.replace(/&(lt|gt|quot|#39|amp);/g, (_, entity: string) => ENTITIES[entity]!);

/** Inline runs nest inside their block's Text, so they carry only what differs from it. */
function renderInlines(tokens: Token[], styles: Styles, prefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    const nested = (style?: TextStyle): ReactNode => (
      <Text key={key} style={style}>{renderInlines(children(token), styles, key)}</Text>
    );
    switch (token.type) {
      case "strong": return nested(styles.strong);
      case "em": return nested(styles.em);
      case "del": return nested(styles.del);
      case "link": return nested(styles.link);
      case "codespan": return <Text key={key} style={styles.inlineCode}>{` ${unescape(token.text)} `}</Text>;
      case "br": return "\n";
      case "image": return token.text;
      default: {
        const inline = token as Tokens.Generic;
        if (inline.tokens !== undefined) return nested();
        return unescape(inline.text ?? inline.raw);
      }
    }
  });
}

function renderBlocks(tokens: Token[], styles: Styles, prefix: string, textStyle?: TextStyle): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    switch (token.type) {
      case "space":
      case "checkbox":
      case "def":
        return null;
      case "html":
        return <Text key={key} selectable style={[styles.text, textStyle]}>{token.raw}</Text>;
      case "hr":
        return <View key={key} style={styles.separator} />;
      case "code":
        return (
          <ScrollView key={key} horizontal style={styles.codeBlock} contentContainerStyle={styles.codeContent}>
            <Text selectable style={styles.codeText}>{token.text}</Text>
          </ScrollView>
        );
      case "heading":
        return (
          <Text key={key} style={[styles.text, textStyle, styles.heading, styles.headingSizes[(token as Tokens.Heading).depth - 1]]}>
            {renderInlines(children(token), styles, key)}
          </Text>
        );
      case "blockquote":
        return <View key={key} style={styles.quote}>{renderBlocks(children(token), styles, key, styles.quoteText)}</View>;
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        return (
          <View key={key} style={styles.list}>
            {list.items.map((item, itemIndex) => (
              <View key={`${key}-${itemIndex}`} style={styles.listRow}>
                <Text style={styles.bullet}>
                  {item.task ? (item.checked === true ? "☑" : "☐") : list.ordered ? `${start + itemIndex}.` : "•"}
                </Text>
                <View style={styles.listItem}>{renderBlocks(children(item), styles, `${key}-${itemIndex}`, textStyle)}</View>
              </View>
            ))}
          </View>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        const rows = [table.header, ...table.rows];
        // Columns size to their widest cell (within reason) and the table scrolls sideways
        // on narrow screens instead of crushing every cell to a sliver.
        const widths = table.header.map((_, column) => Math.min(240, Math.max(56,
          ...rows.map(cells => (cells[column]?.text.length ?? 0) * 7.5 + 16))));
        return (
          <ScrollView key={key} horizontal>
            <View style={styles.table}>
              {rows.map((cells, rowIndex) => (
                <View key={`${key}-${rowIndex}`} style={rowIndex === 0 ? [styles.tableRow, styles.tableHead, { borderTopWidth: 0 }] : styles.tableRow}>
                  {cells.map((cell, cellIndex) => (
                    <Text
                      key={`${key}-${rowIndex}-${cellIndex}`}
                      style={[styles.text, textStyle, styles.tableCell, { width: widths[cellIndex], textAlign: table.align[cellIndex] ?? "left" },
                        rowIndex === 0 ? styles.strong : undefined]}
                    >{renderInlines(children(cell), styles, `${key}-${rowIndex}-${cellIndex}`)}</Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      }
      default: {
        const block = token as Tokens.Generic;
        return (
          <Text key={key} selectable={Platform.OS === "web"} style={[styles.text, textStyle]}>
            {renderInlines(block.tokens ?? Lexer.lexInline(block.text ?? block.raw), styles, key)}
          </Text>
        );
      }
    }
  });
}

/** Attribution stays inline; a separate timestamp column reserves space on the first render. */
export function SquareMarkdownBody({ text, palette, author, reach, time }: {
  text: string;
  palette: SquarePalette;
  author?: string;
  reach?: string;
  time?: string;
}) {
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const tokens = useMemo(() => lexer(text).filter(token => token.type !== "space"), [text]);
  const attribution = <>
    {author !== undefined && <Text style={styles.lead}>{author}</Text>}
    {reach !== undefined && <Text style={{ fontSize: 11, fontWeight: "500", color: palette.warm }}>{" "}{reach}</Text>}
    {(author !== undefined || reach !== undefined) && "\u2002"}
  </>;
  const timeStyle: TextStyle = { color: palette.faint, fontSize: 11, lineHeight: 20, fontVariant: ["tabular-nums"] };
  const first = tokens[0];
  const runIn = first?.type === "paragraph" || first?.type === "heading";
  const hasHeader = author !== undefined || reach !== undefined || time !== undefined;
  const firstLine = <>{attribution}{runIn && renderInlines(children(first), styles, "first")}</>;
  return <View style={styles.block}>
    {hasHeader && <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
      <Text selectable={Platform.OS === "web"} style={[styles.text, { flex: 1, minWidth: 0 }]}>
        {firstLine}
      </Text>
      {time !== undefined && <Text style={[timeStyle, { flexShrink: 0 }]}>{time}</Text>}
    </View>}
    {renderBlocks(hasHeader && runIn ? tokens.slice(1) : tokens, styles, "body")}
  </View>;
}
