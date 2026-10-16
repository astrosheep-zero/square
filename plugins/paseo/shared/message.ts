import { z } from "zod";

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
  fullText: z.string().optional(),
  items: squareCardDetailsSchema.shape.items.optional(),
});
export type SquareMessageData = z.output<typeof squareMessageSchema>;
