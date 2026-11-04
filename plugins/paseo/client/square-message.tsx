import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { COLLAPSED_PREVIEW_MAX_CHARS, outputPreview, type SquareMessageData } from "../shared/message";
import { MONO, SquareCue, SquareInline, SquareMarkdownBody } from "./markdown";
import { squarePalette } from "./palette";

/**
 * A matte slate slip in the timeline's shared 4px-corner family: square seal ■,
 * thin quote guide under the header.
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
  const squareItems = items?.filter(entry => "square" in entry);
  const latest = items?.at(-1);
  // Keep the source's own line breaks: collapsed and expanded text must wrap alike.
  const preview = latest && "text" in latest ? outputPreview(latest.text, COLLAPSED_PREVIEW_MAX_CHARS)
    : latest?.preview ?? text;
  const speakers = [...new Set(squareItems?.map(entry => entry.actor))];
  const chorus = speakers.length > 1;
  const squares = [...new Set(squareItems?.map(entry => entry.square))];
  const squareName = squares.join(", ") || "Square";
  const bell = squareItems?.at(-1)?.route === "bell";
  // Exact IDs never imply intervening activities, and different squares keep their own IDs.
  const trailing = [squareItems?.map(entry => squares.length > 1 ? `${entry.square} ${entry.act}` : entry.act).join(", "),
    squareItems && squareItems.length > 1 ? String(squareItems.length) : undefined].filter(Boolean).join(" · ");
  const { accent, border, foreground, foregroundMuted: muted, surface1 } = palette.theme.colors;
  // On web the header brightens its details under the cursor; touch keeps them quiet.
  const detail = layout.platform === "web" && hovered ? foreground : muted;
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 };
  const indent = { paddingLeft: 15 };

  return (
    <View style={[
      { backgroundColor: surface1, borderWidth: palette.card.borderWidth, borderColor: border, borderRadius: palette.card.borderRadius, paddingHorizontal: 10, paddingVertical: 7 },
      layout.platform === "web" && { boxShadow: palette.card.boxShadow },
    ]}>
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
          <View style={{ width: 6, height: 6, borderRadius: palette.seal.borderRadius, backgroundColor: accent }} />
          <Text numberOfLines={1} style={{ color: foreground, fontSize: 11.5, lineHeight: 17, fontWeight: "600", flex: 1 }}>
            {squareName}
            {(speakers.length > 0 || bell) && (
              <Text style={{ color: muted, fontWeight: "400", fontSize: 10.5 }}> · {[speakers.join(", "), bell ? "🔔" : ""].filter(Boolean).join(" · ")}</Text>
            )}
          </Text>
          {trailing !== "" && <Text numberOfLines={1} style={{ color: detail, fontSize: 9.5, fontFamily: MONO, fontVariant: ["tabular-nums"], flexShrink: 1 }}>{trailing}</Text>}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={10} color={detail} />
        </View>
        {!expanded && preview !== undefined && preview !== "" && (
          <View style={{ ...indent, marginTop: 5, marginLeft: 2.5, paddingLeft: palette.quote.paddingLeft, borderLeftWidth: palette.quote.borderLeftWidth, borderLeftColor: palette.quote.borderLeftColor }}>
            <SquareInline text={preview} theme={palette.theme} numberOfLines={2} lead={chorus && latest && "actor" in latest ? latest.actor : undefined} />
          </View>
        )}
      </Pressable>
      {expanded && (
        <ScrollView style={{ maxHeight: layout.compact ? 280 : 400, marginTop: 3 }} nestedScrollEnabled>
          <View style={{ ...indent, gap: 7 }}>
            {items === undefined ? <SquareMarkdownBody text={text ?? ""} theme={palette.theme} /> : items.map((entry, index) => "text" in entry ? (
              <SquareMarkdownBody key={index} text={entry.text} theme={palette.theme} />
            ) : (
              <View key={index} style={{ gap: 6 }}>
                {entry.route === "bell"
                  ? <SquareCue theme={palette.theme} label={`${entry.actor} 🔔 · ${entry.square} · ${entry.act}`} />
                  : <Text style={{ color: muted, fontSize: 11, fontFamily: MONO }}>{entry.square} · {entry.act}</Text>}
                <SquareMarkdownBody text={entry.body} theme={palette.theme} lead={chorus ? entry.actor : undefined} actor={entry.actor} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
