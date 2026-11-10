import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { OUTPUT_DISPLAY_MAX_CHARS, outputPreview, squareCardDetailsSchema, type SquareMessageData } from "../shared/message.ts";

// Recognition is metadata-based, not a guess from a tool name or body text.
// The same projection applies to live events and fetched history.
export const transformSquareMessage: PluginTimelineTransformerContribution<"tool_call">["transform"] = ({ item }) => {
  if (item.metadata?.synthetic !== true ||
      item.metadata.customType !== "square" ||
      item.detail.type !== "plain_text" ||
      typeof item.detail.text !== "string") return;

  const details = squareCardDetailsSchema.safeParse(item.metadata.details);
  let data: SquareMessageData;
  if (details.success) {
    const items = details.data.items;
    let remaining = OUTPUT_DISPLAY_MAX_CHARS;
    const clipped = items.reduce((sum, entry) => sum + ("text" in entry ? entry.text : entry.body).length, 0) > remaining;
    data = { items: items.map((entry, index) => {
      const source = "text" in entry ? entry.text : entry.body;
      const body = clipped ? outputPreview(source, Math.floor(remaining / (items.length - index))) : source;
      remaining -= body.length;
      if ("text" in entry) return { text: body };
      return { ...entry, body };
    }) };
  } else {
    data = { text: outputPreview(item.detail.text) };
  }
  return {
    items: [{
      type: "plugin",
      kind: "square-message",
      version: 1,
      data,
    }],
  };
};
