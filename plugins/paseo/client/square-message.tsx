import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { SquareMessageData } from "../shared/message";
import { MONO, SquareCue, SquareInline, SquareMarkdownBody } from "./markdown";
import { squarePalette } from "./palette";

/**
 * The accent ■ marks the square itself, not a route.
 * Header (both states): ■ square · who spoke … act ids · how many.
 * Collapsed: two preview lines. Expanded: the whole scene, at full width.
 * Each structured message keeps its own sender, activity id and body.
 * A bell or an *action* is stage direction, a caption on a hairline.
 */
export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const palette = useMemo(() => squarePalette(theme), [theme]);
  const items = "items" in item.data ? item.data.items : undefined;
  const text = "text" in item.data ? item.data.text : undefined;
  const latest = items?.at(-1);
  const preview = (latest?.preview ?? text)?.replace(/\s+/g, " ").trim();
  const speakers = [...new Set(items?.map(entry => entry.actor))];
  const squares = [...new Set(items?.map(entry => entry.square))];
  const squareName = squares.join(", ") || "Square";
  const bell = latest?.route === "bell";
  // Exact IDs never imply intervening activities, and different squares keep their own IDs.
  const actIds = items?.map(entry => entry.act) ?? [];
  const trailing = [items?.map(entry => squares.length > 1 ? `${entry.square} ${entry.act}` : entry.act).join(", "),
    items && items.length > 1 ? String(items.length) : undefined].filter(Boolean).join(" · ");
  const { accent, border, foreground, foregroundMuted: muted, surface1 } = palette.theme.colors;
  // On web the header brightens its details under the cursor; touch keeps them quiet.
  const detail = layout.platform === "web" && hovered ? foreground : muted;
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 };
  const indent = { paddingLeft: 15 };
  // Native slab: the same stone as a tiled image skin (gradients-only backgroundImage
  // can't take url()). The skin lives in its own clipping shell, never holding the
  // drawer, so an expanding card can't smear against an overflow-hidden frame.
  const skin = layout.platform === "web" ? undefined : palette.skin(`${squareName} ${actIds[0] ?? ""}`);

  return (
    <View style={[
      { backgroundColor: surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 9 },
      layout.platform === "web" && palette.stone(`${squareName} ${actIds[0] ?? ""}`) as ViewStyle,
      skin && { borderBottomColor: skin.edge, boxShadow: skin.boxShadow } as ViewStyle,
    ]}>
      {skin && (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 4, overflow: "hidden", pointerEvents: "none" }}>
          <Image source={skin.tile} resizeMode="repeat" style={{ position: "absolute", ...skin.frame }} />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "收起" : "展开"} ${squareName}: ${speakers.join(", ") || "Square"}`}
        aria-expanded={expanded}
        onPress={() => setExpanded(value => !value)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <View style={row}>
          <View style={[{ width: 9, height: 9, borderRadius: 1.5, backgroundColor: accent }, (layout.platform === "web" ? palette.inlay : skin ? { boxShadow: skin.inlay } : undefined) as ViewStyle]} />
          <Text numberOfLines={1} style={{ color: foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
            {squareName}
            {(speakers.length > 0 || bell) && (
              <Text style={{ color: muted, fontWeight: "400" }}> · {[speakers.join(", "), bell ? "🔔" : ""].filter(Boolean).join(" · ")}</Text>
            )}
          </Text>
          {trailing !== "" && <Text numberOfLines={1} style={{ color: detail, fontSize: 11, fontFamily: MONO, fontVariant: ["tabular-nums"], flexShrink: 1 }}>{trailing}</Text>}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={15} color={detail} />
        </View>
        {!expanded && preview !== undefined && preview !== "" && (
          <View style={{ ...indent, marginTop: 3 }}>
            <SquareInline text={preview} theme={palette.theme} numberOfLines={2} lead={latest?.actor} />
          </View>
        )}
      </Pressable>
      {expanded && (
        <ScrollView style={{ maxHeight: layout.compact ? 280 : 400, marginTop: 3 }} nestedScrollEnabled>
          <View style={{ ...indent, gap: 7 }}>
            {items === undefined ? <SquareMarkdownBody text={text ?? ""} theme={palette.theme} /> : items.map((entry, index) => (
              <View key={index} style={{ gap: 6 }}>
                {entry.route === "bell"
                  ? <SquareCue theme={palette.theme} label={`${entry.actor} 🔔 · ${entry.square} · ${entry.act}`} />
                  : <Text style={{ color: muted, fontSize: 11, fontFamily: MONO }}>{entry.square} · {entry.act}</Text>}
                <SquareMarkdownBody text={entry.body} theme={palette.theme} lead={entry.actor} actor={entry.actor} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
