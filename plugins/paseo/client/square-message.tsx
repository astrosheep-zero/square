import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { cardReferences, reachLabel, timeLabel } from "../shared/card-format";
import type { SquareMessageData } from "../shared/message";
import { midLineHeight, type TextLine } from "../shared/text-layout";
import { SquareMarkdownBody } from "./markdown";
import { squarePalette, withAlpha } from "./palette";
import { LineMeasurement, webTextLines } from "./text-layout";

const COLLAPSED_HEIGHT = 4.5 * 20;
const EXPANDED_HEIGHT = 260;
/** CSS gradient on web; React Native's own backgroundImage on native. */
const gradient = (image: string) => Platform.OS === "web"
  ? { backgroundImage: image } as object : { experimental_backgroundImage: image };

export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [content, setContent] = useState({ width: 0, height: 0 });
  const [cut, setCut] = useState<number>();
  const [scrollY, setScrollY] = useState(0);
  const root = useRef<View>(null);
  const scroll = useRef<ScrollView>(null);
  const lines = useRef(new Map<string, TextLine[]>());
  const frame = useRef<number | undefined>(undefined);
  const palette = useMemo(() => squarePalette(theme), [theme]);
  const entries = useMemo(() => "items" in item.data ? item.data.items : [{ text: item.data.text }], [item.data]);
  const presentations = entries.filter(entry => "origin" in entry);
  const originName = [...new Set(presentations.map(entry => entry.origin))].join(", ") || "Notification";
  const refs = cardReferences(presentations);
  const remeasure = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const measuredLines = Platform.OS === "web" && root.current ? webTextLines(root.current) : [...lines.current.values()].flat();
      setCut(midLineHeight(measuredLines, COLLAPSED_HEIGHT));
    });
  }, []);
  const report = useCallback((id: string, measured: TextLine[]) => {
    if (measured.length) lines.current.set(id, measured);
    else lines.current.delete(id);
    remeasure();
  }, [remeasure]);
  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); }, []);
  const geometry = `${content.width}:${content.height}`;
  useEffect(remeasure, [geometry, entries, remeasure]);
  const measurement = useMemo(() => ({ root, geometry, report }), [geometry, report]);
  const overflows = content.height > COLLAPSED_HEIGHT;
  const open = overflows && expanded;
  // Before the first measurement, cap instead of forcing a height so short cards never flash taller.
  const height = overflows ? (open ? Math.min(content.height, EXPANDED_HEIGHT) : cut ?? COLLAPSED_HEIGHT)
    : content.height || undefined;
  const fade = overflows && (!open || scrollY + (height ?? 0) < content.height - 1);
  const { accent, border, foregroundMuted: muted, surface1 } = palette.theme.colors;
  const detail = layout.platform === "web" && hovered ? muted : palette.faint;
  const toggle = () => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    setScrollY(0);
    setExpanded(value => !value);
  };

  // The whole card toggles, as before; short cards have nothing to toggle.
  return <Pressable disabled={!overflows} onPress={toggle}
    accessibilityRole={overflows ? "button" : undefined}
    accessibilityLabel={overflows ? `${open ? "Collapse" : "Expand"} ${originName}` : originName}
    accessibilityState={overflows ? { expanded: open } : undefined}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={{ backgroundColor: surface1, borderWidth: palette.card.borderWidth,
      borderColor: border, borderRadius: palette.card.borderRadius, paddingVertical: 9, paddingHorizontal: 12 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 16 }}>
      <View style={{ width: 5, height: 5, backgroundColor: accent }} />
      <Text numberOfLines={1} style={{ color: muted, fontSize: 11, fontWeight: "500", flexShrink: 1 }}>{originName}</Text>
      {entries.length > 1 && <Text style={{ color: detail, fontSize: 11 }}>{entries.length} messages</Text>}
      <View style={{ flex: 1 }} />
      {!!refs && <Text numberOfLines={1} style={{ color: detail, fontSize: 11, fontVariant: ["tabular-nums"], flexShrink: 1 }}>{refs}</Text>}
      {overflows && <Icon name={open ? "ChevronUp" : "ChevronDown"} size={10} color={detail} />}
    </View>
    <View style={{ marginTop: 8, marginLeft: 2, height, maxHeight: height ?? COLLAPSED_HEIGHT, overflow: "hidden" }}>
      <ScrollView ref={scroll} style={height === undefined ? undefined : { height }} scrollEnabled={open} nestedScrollEnabled
        showsVerticalScrollIndicator={false} scrollEventThrottle={16}
        onScroll={event => setScrollY(event.nativeEvent.contentOffset.y)}>
        <LineMeasurement.Provider value={measurement}>
          <View ref={root} collapsable={false} onLayout={event => {
            const { width, height } = event.nativeEvent.layout;
            setContent(previous => previous.width === width && previous.height === height ? previous : { width, height });
          }}>
            {entries.map((entry, index) => {
              const structured = "origin" in entry;
              const reach = structured ? reachLabel(entry.reach) : undefined;
              return <View key={index} style={{ borderLeftWidth: 1,
                borderLeftColor: reach ? palette.directGuide : palette.quote.borderLeftColor,
                paddingLeft: palette.quote.paddingLeft, marginTop: index > 0 ? 8 : 0 }}>
                <SquareMarkdownBody text={structured ? entry.body : entry.text} palette={palette}
                  author={structured ? entry.author : undefined} reach={reach}
                  time={structured && entry.at !== undefined ? timeLabel(entry.at) : undefined} />
              </View>;
            })}
          </View>
        </LineMeasurement.Provider>
      </ScrollView>
      {fade && <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0,
        height: open ? 26 : 22, ...gradient(`linear-gradient(${withAlpha(surface1, 0)}, ${surface1})`) }} />}
    </View>
  </Pressable>;
}
