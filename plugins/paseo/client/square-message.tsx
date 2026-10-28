import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { parseSquareBlocks, parseSquareVoice, type SquareMessageData } from "../shared/message";
import { SquareInline, SquareMarkdownBody } from "./markdown";
import { squarePalette } from "./palette";

/**
 * The accent ■ marks the square itself, not a route.
 * Collapsed: ■ who spoke · where · how many, then two preview lines.
 * Expanded: the same header, then the bodies indented under it — one voice bare,
 * several voices each behind their own ● glyph. No divider rules, no narration.
 */
export function SquareMessage({ item, theme, layout }: PluginTimelineItemProps<SquareMessageData>) {
  const [expanded, setExpanded] = useState(false);
  const palette = useMemo(() => squarePalette(theme), [theme]);
  const { text, items } = item.data;
  const latest = items?.[items.length - 1];
  const preview = latest?.preview?.replace(/\s+/g, " ").trim();
  const blocks = useMemo(() => parseSquareBlocks(text), [text]);
  const multi = blocks.length > 1;
  const single = multi ? undefined : parseSquareVoice(blocks[0].actor, blocks[0].meta);
  const names = items !== undefined
    ? items.map(entry => entry.actor)
    : blocks.map(block => parseSquareVoice(block.actor, block.meta).speaker);
  const speakers = [...new Set(names.filter((name): name is string => name !== undefined))];
  const squareName = latest?.square ?? blocks[0].meta?.split("·")[1]?.trim() ?? "Square";
  const bell = latest?.route === "bell" || single?.bell === true;
  const trailing = `· ${squareName}${expanded && single?.actId ? ` · ${single.actId}` : !expanded && items && items.length > 1 ? ` · ${items.length}` : ""}`;
  const { accent, border, foreground, foregroundMuted: muted, surface1 } = palette.theme.colors;
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 };
  const indent = { paddingLeft: 15 };

  return (
    <View style={{ backgroundColor: surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, gap: expanded ? 8 : 3 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "收起" : "展开"} ${squareName}: ${speakers.join(", ") || "Square"}`}
        aria-expanded={expanded}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => ({ gap: 3, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={row}>
          <Text style={{ color: accent, fontSize: 9 }}>■</Text>
          {expanded && multi ? (
            <>
              <Text numberOfLines={1} style={{ color: foreground, fontSize: 12.5, fontWeight: "500", flex: 1 }}>{squareName}</Text>
              <Icon name="ChevronUp" size={15} color={muted} />
            </>
          ) : (
            <>
              <Text numberOfLines={1} style={{ color: foreground, fontSize: 13, fontWeight: "500", flex: 1 }}>
                {speakers.join(", ") || "Square"}
                {bell && <Text style={{ color: muted, fontWeight: "400" }}> · rang the bell</Text>}
              </Text>
              <Text style={{ color: muted, fontSize: 12 }}>{trailing}</Text>
              <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={15} color={muted} />
            </>
          )}
        </View>
        {!expanded && preview !== undefined && preview !== "" && (
          <View style={indent}>
            <SquareInline text={preview} theme={palette.theme} numberOfLines={2} />
          </View>
        )}
      </Pressable>
      {expanded && (
        <ScrollView style={{ maxHeight: layout.compact ? 280 : 400 }} nestedScrollEnabled>
          {multi ? (
            <View style={{ gap: 12 }}>
              {blocks.map((block, index) => {
                const voice = parseSquareVoice(block.actor, block.meta);
                const detail = [voice.bell ? "rang the bell" : undefined, voice.actId ? `· ${voice.actId}` : undefined].filter(Boolean).join(" ");
                return (
                  <View key={voice.actId ?? index} style={{ gap: 3 }}>
                    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                      <Text style={{ fontSize: 10, color: voice.glyph === "○" ? muted : palette.voice }}>{voice.glyph}</Text>
                      {voice.speaker && <Text style={{ color: foreground, fontSize: 13, fontWeight: "500" }}>{voice.speaker}</Text>}
                      <Text numberOfLines={1} style={{ color: muted, fontSize: 12 }}>{detail}</Text>
                    </View>
                    <SquareMarkdownBody text={block.body} theme={palette.theme} style={indent} />
                  </View>
                );
              })}
            </View>
          ) : (
            <SquareMarkdownBody text={blocks[0].body} theme={palette.theme} style={indent} />
          )}
        </ScrollView>
      )}
    </View>
  );
}
