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

export interface SquareBlock { meta?: string; actor?: string; body: string }

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([a-z]+)="([^"]*)"/g)) {
    attributes[match[1]!] = match[2]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return attributes;
}

// A square notification is one or more <square-activity> blocks. Split them out so the
// envelope becomes styled chrome and only the body goes through markdown: where and which
// activity come from tag attributes, or from the leading `· ...` line when the tag has none.
export function parseSquareBlocks(text: string): SquareBlock[] {
  const blocks: SquareBlock[] = [];
  const re = /<square-activity([^>]*)>\n([\s\S]*?)\n<\/square-activity>/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    const before = text.slice(last, index).trim();
    if (before !== "") blocks.push({ body: before });
    const attributes = parseAttributes(match[1]!);
    const innerLines = match[2]!.split("\n");
    const described = [attributes.square, attributes.as, attributes.id].filter((value) => value !== undefined);
    const meta = described.length > 0
      ? `· ${described.join(" · ")}`
      : innerLines[0]?.startsWith("· ") ? innerLines.shift() : undefined;
    const actor = innerLines.shift();
    blocks.push({ meta, actor, body: innerLines.join("\n").trim() });
    last = index + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest !== "") blocks.push({ body: rest });
  if (blocks.length === 0) blocks.push({ body: text });
  return blocks;
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
