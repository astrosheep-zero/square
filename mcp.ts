import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, squareToolFailure, squareToolFailureText } from './square-tools.js';
import { operationEnv } from './participant-identity.js';
import { codexWakeAddress } from './codex-address.js';
import { readClaudeMcpCall } from './claude-mcp-context.js';
import { SQUARE_IDENTITY } from './identity.js';
import { Square, createSquareResourceOwner } from './square-api.js';
import type { SquareAtInput } from './square-facade.js';

type JsonObject = Record<string, unknown>;

/** The server owns its artifact connection lifetime, so callers cannot lend one. */
export interface SquareMcpOptions extends Omit<SquareAtInput, 'resources'> {
  readonly body?: import('./model.js').Body;
  readonly wakeAddress?: import('./model.js').WakeAddress;
}
export type SquareMcpServer = McpServer;

export function createSquareMcpServer(options: SquareMcpOptions): SquareMcpServer {
  const { body: configuredBody, wakeAddress, ...resourceOptions } = options;
  const baseEnv = { ...(resourceOptions.env ?? process.env) };
  const resources = createSquareResourceOwner();
  // Calls to the configured square borrow one server-owned connection.
  const inFlight = new Set<Promise<unknown>>();
  const server = new McpServer({ name: 'square', version: SQUARE_IDENTITY.packageVersion }, {
    instructions: SQUARE_TOOL_INSTRUCTIONS,
  });
  for (const tool of SQUARE_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args, extra) => {
      const call = (async () => {
        let square: Square | undefined;
        try {
          const { location } = args as JsonObject;
          const threadId = extra._meta?.threadId;
          const opencodeSessionId = extra._meta?.['ai.opencode/sessionID'];
          // Claude's plugin endpoint requires the mod's call-local coordinate, never startup identity.
          const claude = baseEnv.SQUARE_CLAUDE_MCP_CONTEXT === '1'
            ? await readClaudeMcpCall(extra._meta?.['claudecode/toolUseId'], baseEnv)
            : undefined;
          const body = claude !== undefined
            ? { channel: 'claude-code', session: claude.sessionId,
              ...(claude.agentId === undefined ? {} : { agent: claude.agentId }) }
            : typeof threadId === 'string' && threadId.trim()
              ? { channel: 'codex', session: threadId }
              : typeof opencodeSessionId === 'string' && opencodeSessionId.trim()
                ? { channel: 'opencode', session: opencodeSessionId }
                : configuredBody;
          const env = claude !== undefined
            ? { ...operationEnv('claude', claude.sessionId, baseEnv),
              // Preserve Claude's session + child flag semantics; an agent loop ID is not a session ID.
              CLAUDE_CODE_CHILD_SESSION: claude.agentId === undefined ? '' : '1' }
            : typeof threadId === 'string' && threadId.trim()
              ? operationEnv('codex', threadId, baseEnv)
              : typeof opencodeSessionId === 'string' && opencodeSessionId.trim()
                ? operationEnv('opencode', opencodeSessionId, baseEnv)
                : baseEnv;
          square = await Square.at({
            ...resourceOptions, env, cwd: claude?.cwd ?? resourceOptions.cwd,
            path: (location as string | undefined) ?? options.path,
            // The server owner is bound to its configured square; overrides close after each call.
            resources: location === undefined && claude === undefined ? resources : undefined,
          }, { signal: extra.signal });
          let text: string;
          try { text = await tool.run(square, args as JsonObject, { signal: extra.signal }, {
            body, wakeAddress: claude === undefined && typeof threadId === 'string' && threadId.trim()
              ? codexWakeAddress(threadId, env) : wakeAddress,
          }); }
          finally { await square.close(); }
          return { content: [{ type: 'text' as const, text }] };
        } catch (error) {
          const failure = squareToolFailure(error, extra.signal);
          const participant = (args as JsonObject).as;
          return { isError: true, content: [{ type: 'text' as const, text: squareToolFailureText(failure, {
            location: square?.location ?? options.path,
            participant: typeof participant === 'string' ? participant : undefined,
          }) }] };
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
