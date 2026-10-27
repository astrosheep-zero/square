import { z } from "zod";

/** Client display budget, including the omission line; source history stays unchanged. */
export const OUTPUT_DISPLAY_MAX_CHARS = 32_000;
export const COLLAPSED_PREVIEW_MAX_CHARS = 1_000;
export function outputPreview(text: string, maxChars = OUTPUT_DISPLAY_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const middle = "\n\n… Showing the beginning and end; the middle is hidden in this preview. …\n\n";
  const headChars = Math.floor((maxChars - middle.length) / 2);
  // Budget in UTF-16 units, but never split a surrogate pair.
  const head = text.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-(maxChars - middle.length - headChars)).replace(/^[\uDC00-\uDFFF]/, "");
  return head + middle + tail;
}

export const squareCardDetailsSchema = z.object({
  fullText: z.string().optional(),
  items: z.array(z.object({
    square: z.string(),
    actor: z.string().optional(),
    recipient: z.string().optional(),
    route: z.enum(["mention", "reply", "attention", "bell"]).optional(),
    preview: z.string().optional(),
    description: z.string(),
  })).min(1),
});

/** Human-facing summary; the stored description is Square's agent voice, and the human is not the recipient. */
export function squareHeadline(item: z.output<typeof squareCardDetailsSchema>["items"][number]): string {
  if (item.actor === undefined || item.route === undefined) return item.description;
  const to = item.recipient;
  switch (item.route) {
    case "mention": return to === undefined ? `${item.actor} spoke your name` : `${item.actor} spoke ${to}'s name`;
    case "reply": return to === undefined ? `${item.actor} answered you` : `${item.actor} answered ${to}`;
    case "attention": return to === undefined ? `${item.actor} spoke · you're listening` : `${item.actor} spoke · ${to} is listening`;
    case "bell": return `${item.actor} rang the bell`;
  }
}

export const squareMessageSchema = z.object({
  text: z.string(),
  items: squareCardDetailsSchema.shape.items.optional(),
});
export type SquareMessageData = z.output<typeof squareMessageSchema>;
