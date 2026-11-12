import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { activityLabel, reachLabel, shortOrigin, timeLabel } from "../shared/card-format";
import type { SquareMessageData } from "../shared/message";
import { outgoingActivityLabel } from "../shared/square-express";
import { SquareMarkdownBody } from "./markdown";
import { squareCardChrome, squareOutgoingChrome, squarePalette, withAlpha } from "./palette";

/** The first guide reaches 4px above its text, toward the seal; the byline (17+3px) plus 4 body lines fit cleanly. */
const GUIDE_LEAD = 4;
const COLLAPSED_HEIGHT = 5 * 20 + GUIDE_LEAD;

/** The count, stamped in the seal's own shape: one small mark per message, a mark and a figure past five; a lone message needs none. */
function Tally({ count, color }: { count: number; color: string }) {
  if (count < 2) return null;
  const mark = <View style={{ width: 3, height: 3, backgroundColor: color }} />;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 2.5, flexShrink: 0 }} accessibilityLabel={`${count} messages`}>
    {count > 5
      ? <>{mark}<Text style={{ color, fontSize: 11, lineHeight: 14, marginLeft: 1.5, fontVariant: ["tabular-nums"] }}>{count}</Text></>
      : Array.from({ length: count }, (_, i) => <View key={i} style={{ width: 3, height: 3, backgroundColor: color }} />)}
  </View>;
}

export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const palette = useMemo(() => squarePalette(theme), [theme]);
  const outgoing = "outgoing" in item.data ? item.data.outgoing : undefined;
  const chrome = useMemo(() => outgoing ? squareOutgoingChrome(theme) : squareCardChrome(palette, layout.platform), [outgoing, palette, layout.platform, theme]);
  const entries = "items" in item.data ? item.data.items : "text" in item.data ? [{ text: item.data.text }] : [];
  const presentations = entries.filter(entry => "origin" in entry);
  const originName = outgoing ? shortOrigin(outgoing.location)
    : [...new Set(presentations.map(entry => shortOrigin(entry.origin)))].join(", ") || "Notification";
  const rows = outgoing ? [{
    body: outgoing.body, author: outgoing.as, label: outgoingActivityLabel(outgoing), direct: true,
    reference: undefined, time: undefined,
  }] : entries.map(entry => {
    if (!("origin" in entry)) return { body: entry.text, direct: false };
    return {
      body: entry.body, author: entry.author, label: activityLabel(entry.reach, entry.recipient, entry.replyTo, entry.label) || undefined,
      direct: reachLabel(entry.reach) !== undefined, reference: entry.ref,
      time: entry.at === undefined ? undefined : timeLabel(entry.at),
    };
  });
  const { accent, foregroundMuted: muted } = palette.theme.colors;
  const detail = layout.platform === "web" && hovered ? muted : palette.faint;
  const open = overflows && expanded;
  const collapsed = overflows && !open;

  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 16 }}>
      <View style={{ width: 5, height: 5, backgroundColor: accent }} />
      <Text numberOfLines={1} style={{ color: muted, fontSize: 11.5, fontWeight: "500", flexShrink: 1 }}>{originName}</Text>
      <View style={{ flex: 1 }} />
      {outgoing
        ? <Text accessibilityLabel={outgoing.status} style={{ fontSize: 12, lineHeight: 16, color: outgoing.status === "running"
          ? palette.warm : outgoing.status === "ok" ? detail : withAlpha(palette.theme.colors.statusDanger, 0.4) }}>
          {{ running: "…", ok: "✓", error: "✕" }[outgoing.status]}
        </Text>
        : <Tally count={entries.length} color={detail} />}
      {overflows && <Icon name={open ? "ChevronUp" : "ChevronDown"} size={10} color={detail} />}
    </View>
  );

  // Keep a bounded inner ScrollView: unbounded height swings disturb Paseo's timeline layout.
  const body = (
    <View style={{ marginTop: 8 - GUIDE_LEAD, marginLeft: 2 }}>
      <ScrollView ref={scroll} style={{ maxHeight: open ? 260 : COLLAPSED_HEIGHT }} scrollEnabled={open} nestedScrollEnabled
        onContentSizeChange={(_, height) => setOverflows(height > COLLAPSED_HEIGHT)}>
        {rows.map((row, index) => <View key={index} style={{ borderLeftWidth: 1,
          borderLeftColor: row.direct ? palette.directGuide : palette.quote.borderLeftColor,
          paddingLeft: palette.quote.paddingLeft, marginTop: index > 0 ? 8 : 0, paddingTop: index > 0 ? 0 : GUIDE_LEAD }}>
          <SquareMarkdownBody text={row.body} palette={palette}
            author={row.author} reach={row.label} reference={row.reference} time={row.time}
            reachColor={outgoing ? palette.action : undefined} openLinks={!collapsed} />
        </View>)}
      </ScrollView>
    </View>
  );

  return (
    <View style={[chrome, { paddingVertical: 9, paddingHorizontal: 12 }]}>
      {overflows
        ? <Pressable onPress={() => {
            scroll.current?.scrollTo({ y: 0, animated: false });
            setExpanded(value => !value);
          }} accessibilityRole="button"
            accessibilityLabel={`${open ? "Collapse" : "Expand"} ${originName}`} aria-expanded={open}
            onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}>
            {header}
          </Pressable>
        : header}
      {/* Collapsed: the clipped window taps open. Expanded: only the header toggles, freeing scroll, selection and links. */}
      {collapsed
        ? <Pressable onPress={() => setExpanded(true)} accessibilityRole="button"
            accessibilityLabel={`Expand ${originName}`}
            onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}>
            {body}
          </Pressable>
        : body}
    </View>
  );
}
