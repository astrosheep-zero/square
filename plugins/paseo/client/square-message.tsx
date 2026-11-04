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
 * Header (both states): ■ origin · authors … refs · how many.
 * Collapsed: two preview lines. Expanded: the whole scene, at full width.
 * Each structured message keeps its own author, reference and body.
 * A badge or an *action* is stage direction, a caption on a hairline.
 */
export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const palette = useMemo(() => squarePalette(theme), [theme]);
  const items = "items" in item.data ? item.data.items : undefined;
  const text = "text" in item.data ? item.data.text : undefined;
  const presentations = items?.filter(entry => "origin" in entry);
  const latest = items?.at(-1);
  // Keep the source's own line breaks: collapsed and expanded text must wrap alike.
  const preview = latest && "text" in latest ? outputPreview(latest.text, COLLAPSED_PREVIEW_MAX_CHARS)
    : latest?.preview ?? text;
  const authors = [...new Set(presentations?.flatMap(entry => entry.author === undefined ? [] : [entry.author]))];
  const chorus = authors.length > 1;
  const origins = [...new Set(presentations?.map(entry => entry.origin))];
  const originName = origins.join(", ") || "Notification";
  const badge = presentations?.at(-1)?.badge;
  // Exact references never imply intervening messages; each origin keeps its own references.
  const trailing = [presentations?.flatMap(entry => entry.ref === undefined ? []
    : [origins.length > 1 ? `${entry.origin} ${entry.ref}` : entry.ref]).join(", "),
    presentations && presentations.length > 1 ? String(presentations.length) : undefined].filter(Boolean).join(" · ");
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
        accessibilityLabel={`${expanded ? "收起" : "展开"} ${originName}: ${authors.join(", ") || "Notification"}`}
        aria-expanded={expanded}
        onPress={() => setExpanded(value => !value)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <View style={row}>
          <View style={{ width: 6, height: 6, borderRadius: palette.seal.borderRadius, backgroundColor: accent }} />
          <Text numberOfLines={1} style={{ color: foreground, fontSize: 11.5, lineHeight: 17, fontWeight: "600", flex: 1 }}>
            {originName}
            {(authors.length > 0 || badge) && (
              <Text style={{ color: muted, fontWeight: "400", fontSize: 10.5 }}> · {[authors.join(", "), badge].filter(Boolean).join(" · ")}</Text>
            )}
          </Text>
          {trailing !== "" && <Text numberOfLines={1} style={{ color: detail, fontSize: 9.5, fontFamily: MONO, fontVariant: ["tabular-nums"], flexShrink: 1 }}>{trailing}</Text>}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={10} color={detail} />
        </View>
        {!expanded && preview !== undefined && preview !== "" && (
          <View style={{ ...indent, marginTop: 5, marginLeft: 2.5, paddingLeft: palette.quote.paddingLeft, borderLeftWidth: palette.quote.borderLeftWidth, borderLeftColor: palette.quote.borderLeftColor }}>
            <SquareInline text={preview} theme={palette.theme} numberOfLines={2} lead={chorus && latest && "author" in latest ? latest.author : undefined} />
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
                {entry.badge
                  ? <SquareCue theme={palette.theme} label={[[entry.author, entry.badge].filter(Boolean).join(" "), entry.origin, entry.ref].filter(Boolean).join(" · ")} />
                  : <Text style={{ color: muted, fontSize: 11, fontFamily: MONO }}>{[entry.origin, entry.ref].filter(Boolean).join(" · ")}</Text>}
                <SquareMarkdownBody text={entry.body} theme={palette.theme} lead={chorus ? entry.author : undefined} author={entry.author} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
