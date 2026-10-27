import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { outputPreview, squareHeadline, type SquareMessageData } from "../shared/message";
import { MONO, parseInline, SquareMarkdown } from "./markdown";

/** A plain card: who, what they did, where, then what they said. No badge, no chrome — the words carry the place. */
export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const { text, items } = item.data;
  const latest = items?.[items.length - 1];
  // Transform already bounded the collapsed preview; only normalise whitespace for the single line.
  const preview = latest?.preview?.replace(/\s+/g, " ").trim();
  const muted = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;

  const styles = useMemo(() => ({
    card: {
      marginVertical: 3,
      marginRight: layout.compact ? 0 : 8,
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 4,
    },
    whoRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    glyph: { color: theme.colors.accent, fontSize: 9 },
    actor: { color: foreground, fontSize: 12.5, fontWeight: "600" as const },
    route: { color: muted, fontSize: 12.5, flex: 1 },
    count: { color: muted, fontSize: 11 },
    preview: { color: foreground, fontSize: 13, lineHeight: 19 },
    action: { color: muted, fontStyle: "italic" as const },
    bold: { fontWeight: "700" as const },
    code: { fontFamily: MONO, fontSize: 12 },
  }), [foreground, layout.compact, muted, theme.colors.accent, theme.colors.border, theme.colors.surface1]);

  const headline = latest !== undefined ? squareHeadline(latest) : "Square context";
  const routeText = latest?.actor !== undefined && headline.startsWith(latest.actor)
    ? headline.slice(latest.actor.length).trim()
    : headline;

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "收起" : "展开"} ${latest?.square ?? "square"}: ${headline}`}
        aria-expanded={expanded}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => ({ gap: 4, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={styles.whoRow}>
          <Text style={styles.glyph}>■</Text>
          {latest?.actor !== undefined && <Text style={styles.actor}>{latest.actor}</Text>}
          <Text numberOfLines={1} style={styles.route}>
            {routeText}{latest?.square !== undefined && ` · ${latest.square}`}
          </Text>
          {items !== undefined && items.length > 1 && <Text style={styles.count}>{items.length}</Text>}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={16} color={muted} />
        </View>
        {!expanded && preview !== undefined && preview !== "" && (
          <Text numberOfLines={2} style={styles.preview}>
            {parseInline(preview).map((part, index) => (
              <Text
                key={index}
                style={[
                  part.italic ? styles.action : undefined,
                  part.bold ? styles.bold : undefined,
                  part.code ? styles.code : undefined,
                ]}
              >{part.text}</Text>
            ))}
          </Text>
        )}
      </Pressable>
      {expanded && (
        <ScrollView style={{ maxHeight: layout.compact ? 280 : 400, marginTop: 2, borderTopWidth: 1, borderTopColor: theme.colors.border }} contentContainerStyle={{ paddingTop: 8 }} nestedScrollEnabled>
          <SquareMarkdown text={outputPreview(text)} theme={theme} />
        </ScrollView>
      )}
    </View>
  );
}
