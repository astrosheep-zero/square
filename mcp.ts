import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { SquareError, isSquareError } from './model.js';
import { operationEnv } from './automatic-session.js';
import { SQUARE_IDENTITY } from './identity.js';
import { createSquareApplication, createSquareResourceOwner } from './square-application.js';
import type { ApplicationFailureDetail, ApplicationOutcome, CatchApplicationOptions, ExpressApplicationOptions, HistoryApplicationQuery, OperationControl, SquareApplication, SquareApplicationContext } from './square-facade.js';

type JsonObject = Record<string, unknown>;
interface ToolDefinition { name: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape, z.core.$strict>; }

/** The server owns its artifact connection lifetime, so callers cannot lend one. */
export interface SquareMcpOptions extends Omit<SquareApplicationContext, 'resources'> {}
export type SquareMcpServer = McpServer;

const activityId = z.string().regex(/^act\/(0|[1-9][0-9]*)$/);
const stringArray = z.array(z.string());
const participantName = z.string().optional().describe("Participant name, same as --as. Defaults to the server's configured participant.");

const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'join', description: 'Join the square as a participant.', inputSchema: z.object({ as: participantName, takeover: z.boolean().optional() }).strict() },
  { name: 'express', description: 'Express a message or embodied action in the square.', inputSchema: z.object({ as: participantName, body: z.string(), mentions: stringArray.optional(), reach: z.enum(['bell']).optional(), reply: activityId.optional(), force: z.boolean().optional(), noWait: z.boolean().optional() }).strict() },
  { name: 'catch', description: 'Catch and consume activities perceptible to the participant.', inputSchema: z.object({ as: participantName, id: activityId.optional(), idle: z.number().finite().min(0).optional(), from: stringArray.optional(), mention: z.boolean().optional(), limit: z.number().int().min(1).optional() }).strict() },
  { name: 'history', description: 'Read the activity stream using stable activity-id cursors.', inputSchema: z.object({ limit: z.number().int().min(1).optional(), order: z.enum(['asc', 'desc']).optional(), before: activityId.optional(), after: activityId.optional(), grep: z.string().optional(), fixed: z.string().optional(), from: stringArray.optional(), mention: z.string().optional() }).strict() },
  { name: 'listen', description: 'Listen for future activity from a participant.', inputSchema: z.object({ as: participantName, target: z.string() }).strict() },
  { name: 'ignore', description: 'Stop listening for future activity from a participant.', inputSchema: z.object({ as: participantName, target: z.string() }).strict() },
  { name: 'listening', description: 'List participants this participant is listening to.', inputSchema: z.object({ as: participantName }).strict() },
  { name: 'hold', description: 'Raise a hand to hold the square.', inputSchema: z.object({ as: participantName, reason: z.string().optional() }).strict() },
  { name: 'resume', description: 'Release the current hold.', inputSchema: z.object({ as: participantName }).strict() },
  { name: 'done', description: 'Leave the square without adding a message.', inputSchema: z.object({ as: participantName }).strict() },
  { name: 'status', description: 'Read the public status of the square.', inputSchema: z.object({}).strict() },
  { name: 'participants', description: 'List participants standing in or done with the square.', inputSchema: z.object({}).strict() },
];

function operation(app: SquareApplication<false>, name: string, args: JsonObject, control: OperationControl): Promise<ApplicationOutcome<object, unknown, false>> {
  switch (name) {
    case 'join': return app.join({ takeover: args.takeover as boolean | undefined }, control);
    case 'express': {
      const { body, noWait, ...options } = args;
      return app.express(body as string, { ...options, noWait } as ExpressApplicationOptions, control);
    }
    case 'catch': return app.catch(args as CatchApplicationOptions, control);
    case 'history': return app.history(args as HistoryApplicationQuery, control);
    case 'listen': return app.listen(args.target as string, control);
    case 'ignore': return app.ignore(args.target as string, control);
    case 'listening': return app.listening(control);
    case 'hold': return app.hold(args.reason as string | undefined, control);
    case 'resume': return app.resume(control);
    case 'done': return app.done(undefined, control);
    case 'status': return app.status(undefined, control);
    case 'participants': return app.participants(control);
    default: throw new SquareError('invalid_args', `Unknown tool: ${name}`);
  }
}

export function createSquareMcpServer(options: SquareMcpOptions): SquareMcpServer {
  const baseEnv = { ...options.env };
  const resources = createSquareResourceOwner();
  // One explicit lifetime for this server: every tool call borrows the same connection.
  const inFlight = new Set<Promise<unknown>>();
  const server = new McpServer({ name: 'square', version: SQUARE_IDENTITY.packageVersion }, {
    instructions: 'The catch tool consumes activities. Use history with act/<index> cursors for read-only archive access.',
  });
  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args, extra) => {
      const call = (async () => {
        try {
          const { as: participant, ...operationArgs } = args as JsonObject;
          const threadId = extra._meta?.threadId;
          const opencodeSessionId = extra._meta?.['ai.opencode/sessionID'];
          const env = typeof threadId === 'string' && threadId.trim()
            ? operationEnv('codex', threadId, baseEnv)
            : typeof opencodeSessionId === 'string' && opencodeSessionId.trim()
              ? operationEnv('opencode', opencodeSessionId, baseEnv)
              : baseEnv;
          const app = createSquareApplication({ ...options, env, participant: (participant as string | undefined) ?? options.participant, resources }, { presentation: false });
          const outcome = await operation(app, tool.name, operationArgs, { signal: extra.signal });
          const structuredContent = outcome.data as JsonObject;
          return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent };
        } catch (error) {
          const normalized = extra.signal.aborted
            ? { code: 'cancelled', message: 'The MCP request was cancelled' }
            : isSquareError(error)
              ? { code: error.code, message: error.message, ...(error.facts === undefined ? {} : { facts: error.facts }) }
              : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
          const operation = error instanceof Error ? (error as Error & { operation?: ApplicationFailureDetail }).operation : undefined;
          const failure = operation === undefined ? normalized : { ...normalized, operation };
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(failure) }], structuredContent: { error: failure } };
        }
      })();
      inFlight.add(call);
      return call.finally(() => { inFlight.delete(call); });
    });
  }
  const close = server.close.bind(server);
  // One idempotent shutdown for both close paths: an explicit server.close() and a
  // transport-initiated disconnect, where the SDK protocol fires onclose by itself.
  let draining: Promise<void> | undefined;
  const drain = (): Promise<void> => draining ??= (async () => {
    // The SDK aborts in-flight request signals before onclose/close returns; wait for
    // those handlers to release the shared connection (their cleanup writes included).
    await Promise.allSettled([...inFlight]);
    await resources.close();
  })();
  server.close = async () => { await close(); await drain(); };
  const priorOnclose = server.server.onclose;
  server.server.onclose = () => {
    // onclose is synchronous, so the disconnect path starts the drain without awaiting it;
    // the handler's own catch keeps an unexpected close failure from crashing the process.
    void drain().catch(() => undefined);
    priorOnclose?.();
  };
  return server;
}

export async function runSquareMcpStdio(options: SquareMcpOptions): Promise<void> {
  const server = createSquareMcpServer(options);
  const transport = new StdioServerTransport();
  const close = () => { void server.close(); };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  await server.connect(transport);
}
