import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { cardReferences, reachLabel, timeLabel } from "../shared/card-format";
import type { SquareMessageData } from "../shared/message";
import { SquareMarkdownBody } from "./markdown";
import { squarePalette } from "./palette";

/** The first guide reaches 4px above its text, toward the seal; the collapsed window still shows 4 lines. */
const GUIDE_LEAD = 4;
const COLLAPSED_HEIGHT = 4 * 20 + GUIDE_LEAD;

export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const palette = useMemo(() => squarePalette(theme), [theme]);
  const entries = "items" in item.data ? item.data.items : [{ text: item.data.text }];
  const presentations = entries.filter(entry => "origin" in entry);
  const originName = [...new Set(presentations.map(entry => entry.origin))].join(", ") || "Notification";
  const refs = cardReferences(presentations);
  const { accent, border, foregroundMuted: muted, surface1 } = palette.theme.colors;
  const detail = layout.platform === "web" && hovered ? muted : palette.faint;

  return <Pressable onPress={() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    setExpanded(value => !value);
  }} accessibilityRole="button"
    accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${originName}`} aria-expanded={expanded}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={{ backgroundColor: surface1, borderWidth: palette.card.borderWidth,
      borderColor: border, borderRadius: palette.card.borderRadius, paddingVertical: 9, paddingHorizontal: 12 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 16 }}>
      <View style={{ width: 5, height: 5, backgroundColor: accent }} />
      <Text numberOfLines={1} style={{ color: muted, fontSize: 11, fontWeight: "500", flexShrink: 1 }}>{originName}</Text>
      {entries.length > 1 && <Text style={{ color: detail, fontSize: 11 }}>{entries.length} messages</Text>}
      <View style={{ flex: 1 }} />
      {!!refs && <Text numberOfLines={1} style={{ color: detail, fontSize: 11, fontVariant: ["tabular-nums"], flexShrink: 1 }}>{refs}</Text>}
      <View style={{ width: 10, height: 10 }}>
        {overflows && <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={10} color={detail} />}
      </View>
    </View>
    <View style={{ marginTop: 8 - GUIDE_LEAD, marginLeft: 2 }}>
      <ScrollView ref={scroll} style={{ maxHeight: expanded ? 260 : COLLAPSED_HEIGHT }} scrollEnabled={expanded} nestedScrollEnabled
        onContentSizeChange={(_, height) => setOverflows(height > COLLAPSED_HEIGHT)}>
        {entries.map((entry, index) => {
          const structured = "origin" in entry;
          // A mention speaks through the guide colour alone; reply and bell keep their word.
          const direct = structured && reachLabel(entry.reach) !== undefined;
          const reach = structured && entry.reach !== "mention" ? reachLabel(entry.reach) : undefined;
          return <View key={index} style={{ borderLeftWidth: 1,
            borderLeftColor: direct ? palette.directGuide : palette.quote.borderLeftColor,
            paddingLeft: palette.quote.paddingLeft, marginTop: index > 0 ? 8 : 0, paddingTop: index > 0 ? 0 : GUIDE_LEAD }}>
            <SquareMarkdownBody text={structured ? entry.body : entry.text} palette={palette}
              author={structured ? entry.author : undefined} reach={reach}
              time={structured && entry.at !== undefined ? timeLabel(entry.at) : undefined} />
          </View>;
        })}
      </ScrollView>
    </View>
  </Pressable>;
}
