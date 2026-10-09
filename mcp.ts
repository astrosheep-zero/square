import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodType } from 'zod/v4';
import { SquareError, isSquareError } from './model.js';
import { createSquareApplication, type ExpressApplicationOptions, type SquareApplication, type SquareApplicationContext } from './square-application.js';
import type { Activity, CatchOptions, HistoryQuery, OperationControl } from './square-facade.js';
import { toPublicActivity } from './views.js';

type JsonObject = Record<string, unknown>;
interface InputProperty { type: string; minimum?: number; enum?: readonly string[]; pattern?: string; items?: { type: 'string' }; }
interface InputSchema { properties: Record<string, InputProperty>; required: string[]; }
interface ToolDefinition { name: string; description: string; inputSchema: InputSchema; }

export interface SquareMcpOptions extends SquareApplicationContext {}
export type SquareMcpServer = McpServer;

const activityIdSchema: InputProperty = { type: 'string', pattern: '^act/(0|[1-9][0-9]*)$' };
const stringArraySchema: InputProperty = { type: 'array', items: { type: 'string' } };
function objectSchema(properties: Record<string, InputProperty>, required: string[] = []): InputSchema { return { properties, required }; }

const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'join', description: 'Join the square as the configured participant.', inputSchema: objectSchema({ takeover: { type: 'boolean' } }) },
  { name: 'express', description: 'Express a message or embodied action in the square.', inputSchema: objectSchema({ body: { type: 'string' }, mentions: stringArraySchema, reach: { type: 'string', enum: ['bell'] }, reply: activityIdSchema, force: { type: 'boolean' }, noWait: { type: 'boolean' } }, ['body']) },
  { name: 'catch', description: 'Catch and consume activities perceptible to the configured participant.', inputSchema: objectSchema({ id: activityIdSchema, idle: { type: 'number', minimum: 0 }, from: stringArraySchema, mention: { type: 'boolean' }, limit: { type: 'integer', minimum: 1 } }) },
  { name: 'history', description: 'Read the activity stream using stable activity-id cursors.', inputSchema: objectSchema({ limit: { type: 'integer', minimum: 1 }, order: { type: 'string', enum: ['asc', 'desc'] }, before: activityIdSchema, after: activityIdSchema, grep: { type: 'string' }, fixed: { type: 'string' }, from: stringArraySchema, mention: { type: 'string' } }) },
  { name: 'listen', description: 'Listen for future activity from a participant.', inputSchema: objectSchema({ target: { type: 'string' } }, ['target']) },
  { name: 'ignore', description: 'Stop listening for future activity from a participant.', inputSchema: objectSchema({ target: { type: 'string' } }, ['target']) },
  { name: 'listening', description: 'List participants this participant is listening to.', inputSchema: objectSchema({}) },
  { name: 'hold', description: 'Raise a hand to hold the square.', inputSchema: objectSchema({ reason: { type: 'string' } }) },
  { name: 'resume', description: 'Release the current hold.', inputSchema: objectSchema({}) },
  { name: 'done', description: 'Leave the square without adding a message.', inputSchema: objectSchema({}) },
  { name: 'status', description: 'Read the public status of the square.', inputSchema: objectSchema({}) },
  { name: 'participants', description: 'List participants standing in or done with the square.', inputSchema: objectSchema({}) },
];

function zodInputSchema(schema: InputSchema) {
  const shape: Record<string, ZodType> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    let field: ZodType;
    if (property.type === 'string' && property.enum !== undefined) field = z.enum(property.enum as [string, ...string[]]);
    else if (property.type === 'string') field = property.pattern === undefined ? z.string() : z.string().regex(new RegExp(property.pattern));
    else if (property.type === 'boolean') field = z.boolean();
    else if (property.type === 'number') field = z.number().finite().min(property.minimum ?? -Infinity);
    else if (property.type === 'integer') field = z.number().int().min(property.minimum ?? -Infinity);
    else if (property.type === 'array') field = z.array(z.string());
    else throw new Error(`Unsupported input schema type: ${property.type}`);
    shape[key] = schema.required.includes(key) ? field : field.optional();
  }
  return z.object(shape).strict();
}

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
    server.registerTool(tool.name, { description: tool.description, inputSchema: zodInputSchema(tool.inputSchema) }, async (args, extra) => {
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
