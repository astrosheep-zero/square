import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { SquareMessageData } from "../shared/message";

export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const toast = useToast();
  const { text, items } = item.data;
  const first = items?.[0];
  const muted = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;
  const padding = layout.compact ? 12 : 16;

  return (
    <View style={{
      backgroundColor: theme.colors.surface1,
      borderRadius: 10,
      overflow: "hidden",
    }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={first?.description ?? "Square context"}
        aria-expanded={expanded}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: padding,
          paddingVertical: 12,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ color: theme.colors.accent, fontSize: 11 }}>■</Text>
        <View style={{
          flex: 1,
          minWidth: 0,
          flexDirection: layout.compact ? "column" : "row",
          alignItems: layout.compact ? "flex-start" : "center",
          gap: layout.compact ? 3 : 12,
        }}>
          <Text numberOfLines={layout.compact ? 2 : 1}
            style={{ color: foreground, fontSize: 13, fontWeight: "500", lineHeight: 19, flexShrink: 1 }}>
            {first?.description ?? "Square context"}
          </Text>
          {first && <Text numberOfLines={1} style={{ color: muted, fontSize: 11, lineHeight: 16, flexShrink: 1 }}>
            {first.square}{items && items.length > 1 ? ` · +${items.length - 1} more` : ""}
          </Text>}
        </View>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
      </Pressable>
      {expanded && <View style={{
        marginHorizontal: padding,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 12,
        paddingBottom: 12,
        gap: 12,
      }}>
        <Text selectable style={{
          color: foreground,
          fontSize: 12,
          lineHeight: 20,
          fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
        }}>{text}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy Square content"
          onPress={() => { void copyText(text).catch(() => toast.error("Could not copy Square content")); }}
          style={({ pressed }) => ({
            alignSelf: "flex-end",
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingVertical: 4,
            paddingHorizontal: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon name="Copy" size={12} color={muted} />
          <Text style={{ color: muted, fontSize: 11 }}>Copy content</Text>
        </Pressable>
      </View>}
    </View>
  );
}
