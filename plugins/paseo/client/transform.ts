import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { squareCardDetailsSchema } from "../shared/message.ts";

// Recognition is metadata-based, not a guess from a tool name or body text.
// The same projection applies to live events and fetched history.
export const transformSquareMessage: PluginTimelineTransformerContribution<"tool_call">["transform"] = ({ item }) => {
  if (item.metadata?.synthetic !== true ||
      item.metadata.customType !== "square" ||
      item.detail.type !== "plain_text" ||
      typeof item.detail.text !== "string") return;

  const details = squareCardDetailsSchema.safeParse(item.metadata.details);
  return {
    items: [{
      type: "plugin",
      kind: "square-message",
      version: 1,
      data: {
        text: item.detail.text,
        ...(details.success ? { items: details.data.items } : {}),
      },
    }],
  };
};
