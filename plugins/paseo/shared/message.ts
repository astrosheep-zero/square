import { z } from "zod";

export const squareCardDetailsSchema = z.object({
  items: z.array(z.object({
    square: z.string(),
    description: z.string(),
  })).min(1),
});

export const squareMessageSchema = z.object({
  text: z.string(),
  items: squareCardDetailsSchema.shape.items.optional(),
});
export type SquareMessageData = z.output<typeof squareMessageSchema>;
