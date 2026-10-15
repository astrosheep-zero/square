import { z } from "zod";

export const squareCardDetailsSchema = z.object({
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
    case "mention": return to === undefined ? `${item.actor} mentioned you` : `${item.actor} mentioned ${to}`;
    case "reply": return to === undefined ? `${item.actor} replied to you` : `${item.actor} replied to ${to}`;
    case "attention": return `New from ${item.actor}`;
    case "bell": return `${item.actor} called everyone`;
  }
}

export const squareMessageSchema = z.object({
  text: z.string(),
  items: squareCardDetailsSchema.shape.items.optional(),
});
export type SquareMessageData = z.output<typeof squareMessageSchema>;
