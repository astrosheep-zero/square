import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { SquareError, isSquareError } from './model.js';
import { createSquareApplication, type ExpressApplicationOptions, type SquareApplication, type SquareApplicationContext } from './square-application.js';
import type { Activity, CatchOptions, HistoryQuery, OperationControl } from './square-facade.js';
import { toPublicActivity } from './views.js';

type JsonObject = Record<string, unknown>;
interface ToolDefinition { name: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape, z.core.$strict>; }

export interface SquareMcpOptions extends SquareApplicationContext {}
export type SquareMcpServer = McpServer;

const activityId = z.string().regex(/^act\/(0|[1-9][0-9]*)$/);
const stringArray = z.array(z.string());

const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'join', description: 'Join the square as the configured participant.', inputSchema: z.object({ takeover: z.boolean().optional() }).strict() },
  { name: 'express', description: 'Express a message or embodied action in the square.', inputSchema: z.object({ body: z.string(), mentions: stringArray.optional(), reach: z.enum(['bell']).optional(), reply: activityId.optional(), force: z.boolean().optional(), noWait: z.boolean().optional() }).strict() },
  { name: 'catch', description: 'Catch and consume activities perceptible to the configured participant.', inputSchema: z.object({ id: activityId.optional(), idle: z.number().finite().min(0).optional(), from: stringArray.optional(), mention: z.boolean().optional(), limit: z.number().int().min(1).optional() }).strict() },
  { name: 'history', description: 'Read the activity stream using stable activity-id cursors.', inputSchema: z.object({ limit: z.number().int().min(1).optional(), order: z.enum(['asc', 'desc']).optional(), before: activityId.optional(), after: activityId.optional(), grep: z.string().optional(), fixed: z.string().optional(), from: stringArray.optional(), mention: z.string().optional() }).strict() },
  { name: 'listen', description: 'Listen for future activity from a participant.', inputSchema: z.object({ target: z.string() }).strict() },
  { name: 'ignore', description: 'Stop listening for future activity from a participant.', inputSchema: z.object({ target: z.string() }).strict() },
  { name: 'listening', description: 'List participants this participant is listening to.', inputSchema: z.object({}).strict() },
  { name: 'hold', description: 'Raise a hand to hold the square.', inputSchema: z.object({ reason: z.string().optional() }).strict() },
  { name: 'resume', description: 'Release the current hold.', inputSchema: z.object({}).strict() },
  { name: 'done', description: 'Leave the square without adding a message.', inputSchema: z.object({}).strict() },
  { name: 'status', description: 'Read the public status of the square.', inputSchema: z.object({}).strict() },
  { name: 'participants', description: 'List participants standing in or done with the square.', inputSchema: z.object({}).strict() },
];

function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function publicActivity(activity: Activity): JsonObject { return { ...activity }; }

function publicResult(name: string, value: unknown): unknown {
  if (name === 'status') {
    const result = value as Awaited<ReturnType<SquareApplication['status']>>;
    const state = result.status;
    const { latestAct, participants, ...rest } = state;
    return {
      hardCap: rest.hardCap,
      ...(rest.throttlePerMinute === undefined ? {} : { throttlePerMinute: rest.throttlePerMinute }),
      activeCount: rest.activeCount,
      doneCount: rest.doneCount,
      hold: rest.holdActive ? { by: rest.holdActor, ...(rest.holdReason === undefined ? {} : { reason: rest.holdReason }), ...(rest.holdAt === undefined ? {} : { at: rest.holdAt }) } : null,
      participants: participants.filter((participant) => participant.state !== 'not joined').map((participant) => ({ name: participant.name, state: participant.state, presence: participant.presence, activityCount: participant.activityCount, ...(participant.lastActiveAt === undefined ? {} : { lastActiveAt: participant.lastActiveAt }), unreadActivityCount: participant.unreadActivityCount, pendingMentionCount: participant.pendingMentionCount, listening: participant.listening })),
      ...(latestAct === undefined ? {} : { latestActivity: publicActivity(toPublicActivity(latestAct)) }),
      now: rest.now,
    };
  }
  if (name === 'express' || name === 'hold' || name === 'resume' || name === 'done') {
    const result = value as { activity?: Activity | null; waited?: boolean };
    return { ...(result.activity === undefined ? {} : { activity: result.activity === null ? null : publicActivity(result.activity) }), ...(result.waited === undefined ? {} : { waited: result.waited }) };
  }
  if (name === 'history') return { activities: value };
  if (name === 'participants') return { participants: value };
  if (name === 'listening') return { listening: value };
  return value;
}

function operation(app: SquareApplication, name: string, args: JsonObject, control: OperationControl): Promise<unknown> {
  switch (name) {
    case 'join': return app.join({ takeover: args.takeover as boolean | undefined }, control);
    case 'express': {
      const { body, noWait, ...options } = args;
      return app.express(body as string, { ...options, noWait } as ExpressApplicationOptions, control);
    }
    case 'catch': return app.catch(args as CatchOptions, control);
    case 'history': return app.history(args as HistoryQuery, control);
    case 'listen': return app.listen(args.target as string, control);
    case 'ignore': return app.ignore(args.target as string, control);
    case 'listening': return app.listening(control);
    case 'hold': return app.hold(args.reason as string | undefined, control);
    case 'resume': return app.resume(control);
    case 'done': return app.done(undefined, control);
    case 'status': return app.status();
    case 'participants': return app.participants();
    default: throw new SquareError('invalid_args', `Unknown tool: ${name}`);
  }
}

export function createSquareMcpServer(options: SquareMcpOptions): SquareMcpServer {
  const app = createSquareApplication(options);
  const server = new McpServer({ name: 'square', version: '0.3.61' }, {
    instructions: 'The catch tool consumes activities. Use history with act/<index> cursors for read-only archive access.',
  });
  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args, extra) => {
      try {
        const value = await operation(app, tool.name, args as JsonObject, { signal: extra.signal });
        const projected = publicResult(tool.name, value);
        const structuredContent = isObject(projected) ? projected : { result: projected };
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
      } catch (error) {
        const normalized = extra.signal.aborted
          ? { code: 'cancelled', message: 'The MCP request was cancelled' }
          : isSquareError(error)
            ? { code: error.code, message: error.message, ...(error.facts === undefined ? {} : { facts: error.facts }) }
            : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(normalized) }], structuredContent: { error: normalized } };
      }
    });
  }
  return server;
}

export async function runSquareMcpStdio(options: SquareMcpOptions): Promise<void> {
  await createSquareMcpServer(options).connect(new StdioServerTransport());
}
