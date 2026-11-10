import { Children, cloneElement, isValidElement, useMemo, useState, type ReactNode } from "react";
import { Platform, ScrollView, Text, View, type TextStyle } from "react-native";
import type { SquarePalette } from "./palette";
import { LineText } from "./text-layout";
import { Lexer, lexer, type Token, type Tokens } from "marked";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

function makeStyles(palette: SquarePalette) {
  const colors = palette.theme.colors;
  return {
    block: { gap: 7 },
    text: { color: palette.body, fontSize: 13.5, lineHeight: 20 },
    heading: { fontWeight: "600" as const, color: colors.foreground, marginTop: 2 },
    lead: { color: palette.name, fontWeight: "600" as const },
    strong: { fontWeight: "600" as const, color: colors.foreground },
    em: { color: colors.foregroundMuted, fontStyle: "italic" as const },
    del: { color: colors.foregroundMuted, textDecorationLine: "line-through" as const },
    link: { color: colors.accent, textDecorationLine: "underline" as const },
    inlineCode: { fontFamily: MONO, fontSize: 12, backgroundColor: palette.inlineCode, borderRadius: 3, paddingHorizontal: 4 },
    codeBlock: { backgroundColor: colors.surface0, borderRadius: 4 },
    codeContent: { paddingHorizontal: 10, paddingVertical: 8 },
    codeText: { fontFamily: MONO, fontSize: 12, lineHeight: 18, color: colors.foreground },
    quote: { borderLeftWidth: 1, borderLeftColor: colors.accent, paddingLeft: 10, gap: 7 },
    quoteText: { color: colors.foregroundMuted },
    separator: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
    list: { gap: 3 },
    listRow: { flexDirection: "row" as const },
    // A fixed gutter gives wrapped lines a hanging indent under the first word.
    bullet: { color: colors.foregroundMuted, fontSize: 13.5, lineHeight: 20, minWidth: 14, paddingRight: 4 },
    listItem: { flex: 1, gap: 3 },
    tableRow: { flexDirection: "row" as const, borderBottomWidth: 0.5, borderBottomColor: colors.border },
    tableCell: { paddingVertical: 3, paddingRight: 12 },
  };
}

type Styles = ReturnType<typeof makeStyles>;

/** Children of a token, if it has any: `Token` is a union, so the optional field needs one cast. */
const children = (node: Token | { tokens?: Token[] }): Token[] => (node as { tokens?: Token[] }).tokens ?? [];

const unescape = (text: string): string =>
  text.replace(/&(lt|gt|quot|#39|amp);/g, (_, entity: string) =>
    entity === "lt" ? "<" : entity === "gt" ? ">" : entity === "quot" ? '"' : entity === "#39" ? "'" : "&");

function renderInlines(tokens: Token[], styles: Styles, prefix: string, extra?: TextStyle): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    const nested = (style: TextStyle): ReactNode => (
      <Text key={key} style={[styles.text, extra, style]}>{renderInlines(children(token), styles, key)}</Text>
    );
    switch (token.type) {
      case "strong": return nested(styles.strong);
      case "em": return nested(styles.em);
      case "del": return nested(styles.del);
      case "link": return nested(styles.link);
      case "codespan": return <Text key={key} style={[styles.text, extra, styles.inlineCode]}>{token.text}</Text>;
      case "br": return "\n";
      case "image": return token.text;
      default: {
        const inline = token as Tokens.Generic;
        if (inline.tokens !== undefined) return nested({});
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
        return <LineText key={key} selectable style={[styles.text, textStyle]}>{token.raw}</LineText>;
      case "hr":
        return <View key={key} style={styles.separator} />;
      case "code":
        return (
          <ScrollView key={key} horizontal style={styles.codeBlock} contentContainerStyle={styles.codeContent}>
            <LineText selectable style={styles.codeText}>{token.text}</LineText>
          </ScrollView>
        );
      case "heading":
        return (
          <LineText key={key} style={[styles.text, textStyle, styles.heading]}>
            {renderInlines(children(token), styles, key)}
          </LineText>
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
                <LineText style={styles.bullet}>
                  {item.task ? (item.checked === true ? "☑" : "☐") : list.ordered ? `${start + itemIndex}.` : "•"}
                </LineText>
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
          ...rows.map(cells => (cells[column]?.text.length ?? 0) * 7.5 + 12))));
        return (
          <ScrollView key={key} horizontal>
            <View>
              {rows.map((cells, rowIndex) => (
                <View key={`${key}-${rowIndex}`} style={styles.tableRow}>
                  {cells.map((cell, cellIndex) => (
                    <LineText
                      key={`${key}-${rowIndex}-${cellIndex}`}
                      style={[styles.text, textStyle, styles.tableCell, { width: widths[cellIndex] }, rowIndex === 0 ? styles.strong : undefined]}
                    >{renderInlines(children(cell), styles, `${key}-${rowIndex}-${cellIndex}`)}</LineText>
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
          <LineText key={key} selectable={Platform.OS === "web"} style={[styles.text, textStyle]}>
            {renderInlines(block.tokens ?? Lexer.lexInline(block.text ?? block.raw), styles, key)}
          </LineText>
        );
      }
    }
  });
}

/** Slice rendered inline text without losing emphasis/code/name styles at the wrap. */
function inlineSlice(nodes: ReactNode, start: number, end = Infinity): ReactNode {
  let offset = 0;
  const visit = (children: ReactNode): ReactNode => Children.map(children, child => {
    if (typeof child === "string" || typeof child === "number") {
      const text = String(child), from = offset;
      offset += text.length;
      return text.slice(Math.max(0, start - from), Math.max(0, end - from));
    }
    if (isValidElement<{ children?: ReactNode }>(child)) return cloneElement(child, {}, visit(child.props.children));
    return child;
  });
  return visit(nodes);
}

/** Native Text has no float. Measure the first wrap, then let subsequent lines use the full width. */
function NativeRunIn({ children, time, style, timeStyle }: {
  children: ReactNode; time: string; style: TextStyle; timeStyle: TextStyle;
}) {
  const [width, setWidth] = useState(0);
  const [timeWidth, setTimeWidth] = useState(0);
  const [split, setSplit] = useState<{ key: string; length: number; continues: boolean }>();
  const key = `${width}:${timeWidth}`;
  const length = split?.key === key ? split.length : undefined;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <LineText style={[style, { paddingRight: timeWidth + 12 }]} onTextLayout={event => {
      if (length === undefined && event.nativeEvent.lines.length) setSplit({ key,
        length: event.nativeEvent.lines[0]!.text.length, continues: event.nativeEvent.lines.length > 1 });
    }}>{length === undefined ? children : inlineSlice(children, 0, length)}</LineText>
    {length !== undefined && split?.continues && <LineText style={style}>{inlineSlice(children, length)}</LineText>}
    <Text onLayout={event => setTimeWidth(event.nativeEvent.layout.width)}
      style={[timeStyle, { position: "absolute", top: 0, right: 0 }]}>{time}</Text>
  </View>;
}

/** Attribution stays inline with the first paragraph; the timestamp occupies its right edge. */
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
    {hasHeader && (Platform.OS !== "web" && time !== undefined
      ? <NativeRunIn key={`${text}:${author}:${reach}:${time}`} time={time} style={styles.text} timeStyle={timeStyle}>{firstLine}</NativeRunIn>
      : <LineText selectable={Platform.OS === "web"} style={styles.text}>
          {time !== undefined && <Text style={[timeStyle, { float: "right", marginLeft: 12 } as TextStyle]}>{time}</Text>}
          {firstLine}
        </LineText>)}
    {renderBlocks(hasHeader && runIn ? tokens.slice(1) : tokens, styles, "body")}
  </View>;
}
