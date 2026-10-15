import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { squareHeadline, type SquareMessageData } from "../shared/message";

function withOpacity(color: string, opacity: number): string {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(color);
  if (hex === null) return color;
  const value = hex[1]!.length === 3 ? [...hex[1]!].map((part) => part + part).join("") : hex[1]!;
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, "0");
  return `#${value}${alpha}`;
}

export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const toast = useToast();
  const { text, items } = item.data;
  const latest = items?.[items.length - 1];
  const preview = latest?.preview?.replace(/\s+/g, " ").trim();
  const muted = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;
  const styles = useMemo(() => ({
    marker: { color: theme.colors.accent, fontSize: 10, marginTop: 2 },
    headline: { color: foreground, fontSize: 13, lineHeight: 19, flexShrink: 1 },
    meta: { color: muted, fontSize: 11, lineHeight: 16, flexShrink: 1 },
    preview: { color: foreground, fontSize: 12, lineHeight: 18, flexShrink: 1 },
    bodyPanel: {
      backgroundColor: theme.colors.surface1,
      borderRadius: 12,
      marginTop: 5,
      marginLeft: 17,
      overflow: "hidden" as const,
    },
    bodyText: {
      color: foreground,
      fontSize: 12,
      lineHeight: 21,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      paddingHorizontal: layout.compact ? 10 : 12,
      paddingTop: 8,
    },
  }), [foreground, layout.compact, muted, theme.colors.accent, theme.colors.surface1]);

  return (
    <View>
      <View>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 7, paddingVertical: 2 }}>
          <Text style={styles.marker}>■</Text>
          <Text numberOfLines={1} style={styles.headline}>
            {latest?.square ?? "Square context"}
          </Text>
          {items && items.length > 1 && <Text style={styles.meta}>· {items.length} landed</Text>}
          <View style={{ flex: 1 }} />
          {!expanded && <Pressable
            accessibilityRole="button"
            accessibilityLabel={`展开 ${latest !== undefined ? squareHeadline(latest) : "Square context"}`}
            aria-expanded={false}
            onPress={() => setExpanded(true)}
            hitSlop={6}
            style={({ pressed }) => ({ padding: 5, opacity: pressed ? 0.6 : 1 })}
          >
            <Icon name="ChevronDown" size={18} color={muted} />
          </Pressable>}
        </View>
        {(latest?.actor !== undefined || preview) && <View style={{ marginLeft: 17, marginTop: 2 }}>
          <Text numberOfLines={1} style={styles.preview}>
            <Text style={{ color: theme.colors.accent, fontSize: 10 }}>● </Text>
            {latest?.actor !== undefined && <Text style={styles.meta}>{latest.actor} </Text>}
            {preview}
          </Text>
        </View>}
      </View>
      {expanded && <View style={styles.bodyPanel}>
        <ScrollView style={{ maxHeight: layout.compact ? 280 : 400 }} nestedScrollEnabled>
          <Text selectable style={styles.bodyText}>{text}</Text>
        </ScrollView>
        <View style={{
          marginHorizontal: layout.compact ? 10 : 12,
          marginTop: 5,
          borderTopWidth: 1,
          borderTopColor: withOpacity(theme.colors.border, 0.55),
          paddingVertical: 3,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy Square content"
            onPress={() => { void copyText(text).catch(() => toast.error("Could not copy Square content")); }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 2,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon name="Copy" size={12} color={muted} />
            <Text style={{ color: muted, fontSize: 11 }}>Copy content</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="收起 Square context"
            aria-expanded={true}
            onPress={() => setExpanded(false)}
            hitSlop={6}
            style={({ pressed }) => ({ paddingHorizontal: 5, paddingVertical: 1, opacity: pressed ? 0.6 : 1 })}
          >
            <Icon name="ChevronUp" size={18} color={muted} />
          </Pressable>
        </View>
      </View>}
    </View>
  );
}
