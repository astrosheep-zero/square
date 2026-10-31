import { useMemo, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Lexer, lexer, type Token, type Tokens } from "marked";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

function makeStyles(colors: PluginTheme["colors"]) {
  return {
    block: { gap: 6 },
    text: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    lead: { color: colors.accent, fontWeight: "600" as const },
    strong: { fontWeight: "500" as const, color: colors.foreground },
    em: { color: colors.foregroundMuted, fontStyle: "italic" as const },
    del: { color: colors.foregroundMuted, textDecorationLine: "line-through" as const },
    link: { color: colors.accent, textDecorationLine: "underline" as const },
    inlineCode: { fontFamily: MONO },
    codeBlock: { backgroundColor: colors.surface0, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 6 },
    codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 19, color: colors.foreground },
    quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 8, gap: 2 },
    quoteText: { color: colors.foregroundMuted, fontStyle: "italic" as const },
    separator: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
    listRow: { flexDirection: "row" as const, gap: 6 },
    listItem: { flexShrink: 1, gap: 2 },
    bullet: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    tableRow: { flexDirection: "row" as const, gap: 8 },
    tableCell: { flex: 1 },
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
      case "codespan": return <Text key={key} style={[styles.text, extra, styles.inlineCode]}>{token.text}</Text>;
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
        return null;
      case "html":
        return <Text key={key} selectable style={[styles.text, textStyle]}>{token.raw}</Text>;
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
          <Text key={key} style={[styles.text, textStyle, styles.strong]}>
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
                  {item.task ? (item.checked === true ? "☑" : "☐") : list.ordered ? `${start + itemIndex}.` : "·"}
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
          <Text key={key} selectable={Platform.OS === "web"} style={[styles.text, textStyle]}>
            {renderInlines(block.tokens ?? Lexer.lexInline(block.text ?? block.raw), styles, key)}
          </Text>
        );
      }
    }
  });
}

/** The speaker run into the start of a line: the seal's blue, then the words. */
function Lead({ name, styles }: { name: string; styles: Styles }) {
  return <Text style={styles.lead}>{name}{"  "}</Text>;
}

/** One line (or a few) of Markdown, inline only: the collapsed preview on a notification card. */
export function SquareInline({ text, theme, numberOfLines, lead }: {
  text: string;
  theme: PluginTheme;
  numberOfLines?: number;
  lead?: string;
}) {
  const styles = useMemo(() => makeStyles(theme.colors), [theme.colors]);
  return (
    <Text numberOfLines={numberOfLines} style={styles.text}>
      {lead !== undefined && <Lead name={lead} styles={styles} />}
      {renderInlines(Lexer.lexInline(text), styles, "inline")}
    </Text>
  );
}

/** A paragraph that is one *emphasis* and nothing else is an action, not a line. */
const isAction = (token: Token): token is Tokens.Paragraph =>
  token.type === "paragraph" && children(token).length === 1 && children(token)[0]!.type === "em";

/** A bell or an action is stage direction: a caption on a hairline across the full width. */
export function SquareCue({ label, theme }: { label: ReactNode; theme: PluginTheme }) {
  const rule = { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 2 }}>
      <View style={rule} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, lineHeight: 16, letterSpacing: 0.4 }}>{label}</Text>
      <View style={rule} />
    </View>
  );
}

/**
 * A body of Markdown: no envelope, no route line — the words only, at full width.
 * `lead` runs the speaker into the first line; `actor` names whoever performs an action.
 */
export function SquareMarkdownBody({ text, theme, lead, actor }: {
  text: string;
  theme: PluginTheme;
  lead?: string;
  actor?: string;
}) {
  const styles = useMemo(() => makeStyles(theme.colors), [theme.colors]);
  const tokens = useMemo(() => lexer(text).filter(token => token.type !== "space"), [text]);
  let pending = lead;
  const nodes = tokens.map((token, index) => {
    const key = `body-${index}`;
    if (isAction(token)) {
      const words = renderInlines(children(children(token)[0]!), styles, key);
      return <SquareCue key={key} theme={theme} label={actor === undefined ? words : <>{actor} {words}</>} />;
    }
    if (pending === undefined) return renderBlocks([token], styles, key);
    const name = pending;
    pending = undefined;
    if (token.type === "paragraph") {
      return (
        <Text key={key} selectable={Platform.OS === "web"} style={styles.text}>
          <Lead name={name} styles={styles} />
          {renderInlines(children(token), styles, key)}
        </Text>
      );
    }
    return [<Text key={`${key}-lead`} style={styles.text}><Lead name={name} styles={styles} /></Text>, ...renderBlocks([token], styles, key)];
  });
  return (
    <View style={styles.block}>
      {nodes}
      {pending !== undefined && <Text style={styles.text}><Lead name={pending} styles={styles} /></Text>}
    </View>
  );
}
