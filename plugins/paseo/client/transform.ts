import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { COLLAPSED_PREVIEW_MAX_CHARS, outputPreview, squareCardDetailsSchema } from "../shared/message.ts";

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
        text: outputPreview(details.success && details.data.fullText !== undefined ? details.data.fullText : item.detail.text),
        ...(details.success ? {
          // Only the last item's preview is rendered, so only it takes the visible budget.
          items: details.data.items.map((item, index, all) =>
            index < all.length - 1 || item.preview === undefined ? item : { ...item, preview: outputPreview(item.preview, COLLAPSED_PREVIEW_MAX_CHARS) }),
        } : {}),
      },
    }],
  };
};
