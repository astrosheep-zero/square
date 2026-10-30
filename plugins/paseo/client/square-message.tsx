import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { parseSquareBlocks, parseSquareVoice, type SquareMessageData } from "../shared/message";
import { MONO, SquareCue, SquareInline, SquareMarkdownBody } from "./markdown";
import { squarePalette } from "./palette";

/**
 * The accent ■ marks the square itself, not a route.
 * Header (both states): ■ square · who spoke … act ids · how many.
 * Collapsed: two preview lines. Expanded: the whole scene, at full width.
 * One attribution style for one voice or many — each speaker's name runs into
 * their first line in the seal's color (not repeated while they keep talking);
 * a bell or an *action* is stage direction, a caption on a hairline.
 */
export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const palette = useMemo(() => squarePalette(theme), [theme]);
  const { text, items } = item.data;
  const latest = items?.[items.length - 1];
  const preview = latest?.preview?.replace(/\s+/g, " ").trim();
  const blocks = useMemo(() => parseSquareBlocks(text), [text]);
  const voices = useMemo(() => blocks.map(block => parseSquareVoice(block.actor, block.meta)), [blocks]);
  const names = items !== undefined
    ? items.map(entry => entry.actor)
    : voices.map(voice => voice.speaker);
  const speakers = [...new Set(names.filter((name): name is string => name !== undefined))];
  const squareName = latest?.square ?? blocks[0].meta?.split("·")[1]?.trim() ?? "Square";
  const bell = latest?.route === "bell" || (voices.length === 1 && voices[0].bell);
  // Header is the same in both states; act id is always shown when we know it.
  const actIds = [...new Set(voices.flatMap(voice => voice.actId ? [voice.actId] : []))];
  const trailing = [actSpan(actIds), items && items.length > 1 ? String(items.length) : undefined]
    .filter(Boolean).join(" · ");
  const { accent, border, foreground, foregroundMuted: muted, surface1 } = palette.theme.colors;
  // On web the header brightens its details under the cursor; touch keeps them quiet.
  const detail = layout.platform === "web" && hovered ? foreground : muted;
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 };
  const indent = { paddingLeft: 15 };

  return (
    <View style={[
      { backgroundColor: surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 9 },
      layout.platform === "web" && palette.stone(`${squareName} ${actIds[0] ?? ""}`) as ViewStyle,
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
          <View style={[{ width: 9, height: 9, borderRadius: 1.5, backgroundColor: accent }, layout.platform === "web" && palette.inlay as ViewStyle]} />
          <Text numberOfLines={1} style={{ color: foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
            {squareName}
            {(speakers.length > 0 || bell) && (
              <Text style={{ color: muted, fontWeight: "400" }}> · {[speakers.join(", "), bell ? "🔔" : ""].filter(Boolean).join(" · ")}</Text>
            )}
          </Text>
          {trailing !== "" && <Text style={{ color: detail, fontSize: 11, fontFamily: MONO, fontVariant: ["tabular-nums"] }}>{trailing}</Text>}
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
            {blocks.map((block, index) => {
              const voice = voices[index];
              if (block.body === "" && !voice.bell) return null;
              const repeat = index > 0 && voices[index - 1].speaker === voice.speaker;
              return (
                <View key={voice.actId ?? index} style={{ gap: 6 }}>
                  {voice.bell && <SquareCue theme={palette.theme} label={`${voice.speaker ?? ""} 🔔`} />}
                  <SquareMarkdownBody
                    text={block.body}
                    theme={palette.theme}
                    lead={repeat ? undefined : voice.speaker}
                    actor={voice.speaker}
                  />
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

/** act/18, act/19 → act/18–19; anything else is listed as is. */
function actSpan(ids: string[]): string | undefined {
  if (ids.length < 2) return ids[0];
  const numbers = ids.map(id => /^act\/(\d+)$/.exec(id)?.[1]).map(Number);
  return numbers.every(Number.isInteger) ? `act/${Math.min(...numbers)}–${Math.max(...numbers)}` : ids.join(", ");
}
