import { useMemo, type ReactNode } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Lexer, lexer, type Token, type Tokens } from "marked";
import { parseSquareBlocks } from "../shared/message.ts";

export { parseSquareBlocks };

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

function makeStyles(colors: PluginTheme["colors"]) {
  return {
    block: { gap: 6 },
    text: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    strong: { fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    del: { textDecorationLine: "line-through" as const },
    link: { color: colors.accent, textDecorationLine: "underline" as const },
    inlineCode: { fontFamily: MONO, fontSize: 12, backgroundColor: colors.surface2, color: colors.foreground },
    codeBlock: {
      backgroundColor: colors.surface0,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 9,
      paddingVertical: 7,
    },
    codeText: { fontFamily: MONO, fontSize: 11.5, lineHeight: 17, color: colors.foreground },
    quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 8, gap: 2 },
    quoteText: { color: colors.foregroundMuted, fontStyle: "italic" as const },
    meta: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, fontFamily: MONO },
    actor: { color: colors.accent, fontSize: 12, lineHeight: 17 },
    separator: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
    listRow: { flexDirection: "row" as const, gap: 6 },
    listItem: { flexShrink: 1, gap: 2 },
    bullet: { color: colors.accent, fontSize: 13, lineHeight: 19 },
    tableRow: { flexDirection: "row" as const, gap: 8 },
    tableCell: { flex: 1, fontSize: 12 },
  };
}

type Styles = ReturnType<typeof makeStyles>;

/** Children of a token, if it has any: `Token` is a union, so the optional field needs one cast. */
const children = (node: Token | { tokens?: Token[] }): Token[] => (node as { tokens?: Token[] }).tokens ?? [];

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
      case "codespan": return <Text key={key} style={[styles.text, extra, styles.inlineCode]}>{` ${token.text} `}</Text>;
      case "br": return "\n";
      case "image": return token.text;
      default: {
        const inline = token as Tokens.Generic;
        if (inline.tokens !== undefined) return nested({});
        return inline.text ?? inline.raw;
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
      case "html":
        return null;
      case "hr":
        return <View key={key} style={styles.separator} />;
      case "code":
        return (
          <View key={key} style={styles.codeBlock}>
            <Text selectable style={styles.codeText}>{token.text}</Text>
          </View>
        );
      case "heading":
        return (
          <Text key={key} style={[styles.text, textStyle, styles.strong, { fontSize: Math.max(13, 18 - token.depth) }]}>
            {renderInlines(children(token), styles, key)}
          </Text>
        );
      case "blockquote":
        return <View key={key} style={styles.quote}>{renderBlocks(children(token), styles, key, styles.quoteText)}</View>;
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        return (
          <View key={key} style={{ gap: 2 }}>
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
        return (
          <View key={key} style={{ gap: 2 }}>
            {rows.map((cells, rowIndex) => (
              <View key={`${key}-${rowIndex}`} style={styles.tableRow}>
                {cells.map((cell, cellIndex) => (
                  <Text
                    key={`${key}-${rowIndex}-${cellIndex}`}
                    style={[styles.text, textStyle, styles.tableCell, rowIndex === 0 ? styles.strong : undefined]}
                  >{renderInlines(children(cell), styles, `${key}-${rowIndex}-${cellIndex}`)}</Text>
                ))}
              </View>
            ))}
          </View>
        );
      }
      default: {
        const block = token as Tokens.Generic;
        return (
          <Text key={key} style={[styles.text, textStyle]}>
            {renderInlines(block.tokens ?? Lexer.lexInline(block.text ?? block.raw), styles, key)}
          </Text>
        );
      }
    }
  });
}

/** One line (or a few) of Markdown, inline only: the collapsed preview on a notification card. */
export function SquareInline({ text, theme, numberOfLines, style }: {
  text: string;
  theme: PluginTheme;
  numberOfLines?: number;
  style?: TextStyle;
}) {
  const styles = useMemo(() => makeStyles(theme.colors), [theme.colors]);
  return (
    <Text numberOfLines={numberOfLines} style={[styles.text, style]}>
      {renderInlines(Lexer.lexInline(text), styles, "inline")}
    </Text>
  );
}

export function SquareMarkdown({ text, theme }: { text: string; theme: PluginTheme }) {
  const styles = useMemo(() => makeStyles(theme.colors), [theme.colors]);
  const blocks = useMemo(() => parseSquareBlocks(text), [text]);
  return (
    <View style={styles.block}>
      {blocks.map((block, index) => (
        <View key={index} style={styles.block}>
          {index > 0 && <View style={styles.separator} />}
          {block.meta !== undefined && <Text style={styles.meta}>{block.meta}</Text>}
          {block.actor !== undefined && <Text style={styles.actor}>{block.actor}</Text>}
          {renderBlocks(lexer(block.body), styles, `${index}`)}
        </View>
      ))}
    </View>
  );
}
