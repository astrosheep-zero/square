import { z } from "zod";

const expressInputSchema = z.object({
  location: z.string(),
  as: z.string().optional(),
  body: z.string(),
  mentions: z.array(z.string()).optional(),
  reply: z.string().optional(),
  bell: z.boolean().optional(),
});

export const squareOutgoingSchema = expressInputSchema.extend({
  status: z.enum(["running", "ok", "error"]),
});
export type SquareOutgoing = z.output<typeof squareOutgoingSchema>;

const expressCallSchema = z.object({
  type: z.literal("tool_call"),
  // Pi's nested tool, Claude MCP, and Codex's server.tool normalization.
  name: z.enum(["square_express", "mcp__square__express", "square.express"]),
  status: z.enum(["running", "completed", "failed"]),
  detail: z.object({ type: z.literal("unknown"), input: expressInputSchema }),
});

/** An outgoing card describes the attempted speech, never anything inferred from its output. */
export function parseSquareExpress(item: unknown): SquareOutgoing | undefined {
  const parsed = expressCallSchema.safeParse(item);
  if (!parsed.success) return undefined;
  const { status, detail } = parsed.data;
  return { ...detail.input, status: status === "completed" ? "ok" : status === "failed" ? "error" : "running" };
}

export function outgoingActivityLabel(outgoing: SquareOutgoing): string {
  const actions = [
    outgoing.mentions?.length ? `${outgoing.as ? "→ " : ""}${outgoing.mentions.map(name => `@${name}`).join(", ")}` : undefined,
    outgoing.reply === undefined ? undefined : `reply ${outgoing.reply}`,
    outgoing.bell ? "bell" : undefined,
  ].filter(Boolean);
  return actions.join(" · ") || "express";
}
