import { useMemo } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

interface InlinePart { text: string; bold?: boolean; italic?: boolean; code?: boolean }

// Minimal inline grammar: **bold**, *italic*, `code`. The first marker wins;
// no nesting, so action lines like *leans over* survive intact.
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

export function parseInline(line: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: line.slice(last, index) });
    const token = match[0];
    if (token.startsWith("**")) parts.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) parts.push({ text: token.slice(1, -1), code: true });
    else parts.push({ text: token.slice(1, -1), italic: true });
    last = index + token.length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts;
}

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) { body.push(lines[i]!); i += 1; }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    if (line.startsWith(">")) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) { quote.push(lines[i]!.replace(/^>\s?/, "")); i += 1; }
      i -= 1;
      blocks.push({ kind: "quote", lines: quote });
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]!)) {
        const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        items.push(item?.[1] ?? lines[i]!);
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.trim() === "") { flushParagraph(); continue; }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

interface SquareBlock { meta?: string; actor?: string; body: string }

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([a-z]+)="([^"]*)"/g)) {
    attributes[match[1]!] = match[2]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return attributes;
}

// A square notification is one or more <square-activity> blocks. Split them out so the
// envelope becomes styled chrome and only the body goes through markdown: where and which
// activity come from tag attributes, and the first inner line is the route sentence.
function parseSquareBlocks(text: string): SquareBlock[] {
  const blocks: SquareBlock[] = [];
  const re = /<square-activity([^>]*)>\n([\s\S]*?)\n<\/square-activity>/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    const before = text.slice(last, index).trim();
    if (before !== "") blocks.push({ body: before });
    const attributes = parseAttributes(match[1]!);
    const innerLines = match[2]!.split("\n");
    const described = [attributes.square, attributes.as, attributes.id].filter((value) => value !== undefined);
    const meta = described.length > 0 ? `· ${described.join(" · ")}` : undefined;
    const actor = innerLines.shift();
    blocks.push({ meta, actor, body: innerLines.join("\n").trim() });
    last = index + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest !== "") blocks.push({ body: rest });
  if (blocks.length === 0) blocks.push({ body: text });
  return blocks;
}

export function SquareMarkdown({ text, theme }: { text: string; theme: PluginTheme }) {
  const { colors } = theme;
  const styles = useMemo(() => ({
    block: { gap: 6 },
    paragraph: { color: colors.foreground, fontSize: 13, lineHeight: 20 },
    bold: { fontWeight: "700" as const },
    italic: { fontStyle: "italic" as const },
    inlineCode: {
      fontFamily: MONO,
      fontSize: 12,
      backgroundColor: colors.surface2,
      color: colors.foreground,
    },
    codeBlock: {
      backgroundColor: colors.surface0,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 9,
      paddingVertical: 7,
    },
    codeText: { fontFamily: MONO, fontSize: 11.5, lineHeight: 17, color: colors.foreground },
    heading: { color: colors.foreground, fontWeight: "700" as const },
    quote: {
      borderLeftWidth: 2,
      borderLeftColor: colors.border,
      paddingLeft: 8,
      gap: 2,
    },
    quoteText: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 20, fontStyle: "italic" as const },
    meta: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, fontFamily: MONO },
    actor: { color: colors.accent, fontSize: 12, lineHeight: 17 },
    separator: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
    listRow: { flexDirection: "row" as const, gap: 6 },
    bullet: { color: colors.accent, fontSize: 13, lineHeight: 20 },
  }), [colors]);

  const renderInline = (line: string, keyPrefix: string, extra?: TextStyle) => (
    <Text key={keyPrefix} style={[styles.paragraph, extra]}>
      {parseInline(line).map((part, index) => (
        <Text
          key={`${keyPrefix}-${index}`}
          style={[
            part.bold ? styles.bold : undefined,
            part.italic ? styles.italic : undefined,
            part.code ? styles.inlineCode : undefined,
          ]}
        >{part.code ? ` ${part.text} ` : part.text}</Text>
      ))}
    </Text>
  );

  const renderBlock = (block: Block, key: string) => {
    switch (block.kind) {
      case "code":
        return (
          <View key={key} style={styles.codeBlock}>
            <Text selectable style={styles.codeText}>{block.text}</Text>
          </View>
        );
      case "heading":
        return renderInline(block.text, key, { fontSize: Math.max(13, 18 - block.level), fontWeight: "700" });
      case "quote":
        return (
          <View key={key} style={styles.quote}>
            {block.lines.map((line, index) => (
              <Text key={`${key}-${index}`} style={styles.quoteText}>{line}</Text>
            ))}
          </View>
        );
      case "list":
        return (
          <View key={key} style={{ gap: 2 }}>
            {block.items.map((item, index) => (
              <View key={`${key}-${index}`} style={styles.listRow}>
                <Text style={styles.bullet}>•</Text>
                {renderInline(item, `${key}-${index}-text`, { flexShrink: 1 })}
              </View>
            ))}
          </View>
        );
      case "paragraph":
        return renderInline(block.text, key);
    }
  };

  const blocks = useMemo(() => parseSquareBlocks(text), [text]);

  return (
    <View style={styles.block}>
      {blocks.map((block, blockIndex) => (
        <View key={blockIndex} style={styles.block}>
          {blockIndex > 0 && <View style={styles.separator} />}
          {block.meta !== undefined && <Text style={styles.meta}>{block.meta}</Text>}
          {block.actor !== undefined && <Text style={styles.actor}>{block.actor}</Text>}
          {parseBlocks(block.body).map((inner, innerIndex) => renderBlock(inner, `${blockIndex}-${innerIndex}`))}
        </View>
      ))}
    </View>
  );
}
