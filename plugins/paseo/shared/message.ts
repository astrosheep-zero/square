import { z } from "zod";

/** Aggregate client display budget, including omission lines; source history stays unchanged. */
export const OUTPUT_DISPLAY_MAX_CHARS = 32_000;
export const COLLAPSED_PREVIEW_MAX_CHARS = 1_000;
export function outputPreview(text: string, maxChars = OUTPUT_DISPLAY_MAX_CHARS): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const middle = "\n\n… Showing the beginning and end; the middle is hidden in this preview. …\n\n";
  // Even a small share of a multi-message budget must fit, without splitting a surrogate pair.
  if (maxChars <= middle.length) return text.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
  const headChars = Math.floor((maxChars - middle.length) / 2);
  const head = text.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-(maxChars - middle.length - headChars)).replace(/^[\uDC00-\uDFFF]/, "");
  return head + middle + tail;
}

/** Renderer facts emitted by pendingCardDetails, never derived from body or route prose. */
export const squareCardDetailsSchema = z.object({
  items: z.array(z.object({
    square: z.string(),
    actor: z.string(),
    act: z.string().regex(/^act\/(0|[1-9]\d*)$/),
    body: z.string(),
    recipient: z.string().optional(),
    route: z.enum(["mention", "reply", "attention", "bell"]),
    preview: z.string().optional(),
  })).min(1),
});

export const squareMessageSchema = z.union([
  squareCardDetailsSchema,
  z.object({ text: z.string() }),
]);
export type SquareMessageData = z.output<typeof squareMessageSchema>;
export type SquareNotificationItem = z.output<typeof squareCardDetailsSchema>["items"][number];
