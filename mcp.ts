import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, SquareExpressDrafts, squareToolsEnabled, squareToolFailure, squareToolFailureText } from './square-tools.js';
import { operationEnv } from './participant-identity.js';
import { codexWakeAddress } from './codex-address.js';
import { readClaudeMcpCall } from './claude-mcp-context.js';
import { SQUARE_IDENTITY } from './identity.js';
import { Square, createSquareResourceOwner } from './square-api.js';
import { harnessOwner, type Owner } from './square-api.js';
import type { SquareAtInput } from './square-facade.js';

type JsonObject = Record<string, unknown>;

/** The server owns its artifact connection lifetime, so callers cannot lend one. */
export interface SquareMcpOptions extends Omit<SquareAtInput, 'resources'> {
  readonly owner?: Owner;
  readonly wakeAddress?: import('./model.js').WakeAddress;
}
export type SquareMcpServer = McpServer;

export function createSquareMcpServer(options: SquareMcpOptions): SquareMcpServer {
  const { owner: configuredOwner, wakeAddress, ...resourceOptions } = options;
  const baseEnv = { ...(resourceOptions.env ?? process.env) };
  const toolsEnabled = squareToolsEnabled(baseEnv);
  const resources = createSquareResourceOwner();
  const drafts = new SquareExpressDrafts();
  // Calls to the configured square borrow one server-owned connection.
  const inFlight = new Set<Promise<unknown>>();
  const server = new McpServer({ name: 'square', version: SQUARE_IDENTITY.packageVersion }, {
    ...(toolsEnabled ? { instructions: SQUARE_TOOL_INSTRUCTIONS } : {}),
  });
  if (toolsEnabled) for (const tool of SQUARE_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args, extra) => {
      const call = (async () => {
        let square: Square | undefined;
        let toolArgs = args as JsonObject;
        let owner: Owner | undefined;
        let draftToken: string | undefined;
        let expressAttempted = false;
        try {
          const threadId = extra._meta?.threadId;
          const opencodeSessionId = extra._meta?.['ai.opencode/sessionID'];
          // Claude's plugin endpoint requires the mod's call-local coordinate, never startup identity.
          const claude = baseEnv.SQUARE_CLAUDE_MCP_CONTEXT === '1'
            ? await readClaudeMcpCall(extra._meta?.['claudecode/toolUseId'], baseEnv)
            : undefined;
          owner = claude !== undefined
            ? harnessOwner({ channel: 'claude-code', session: claude.sessionId, ...(claude.agentId === undefined ? {} : { agent: claude.agentId }) })
            : typeof threadId === 'string' && threadId.trim()
              ? harnessOwner({ channel: 'codex', session: threadId })
              : typeof opencodeSessionId === 'string' && opencodeSessionId.trim()
                ? harnessOwner({ channel: 'opencode', session: opencodeSessionId })
                : configuredOwner;
          if (tool.name === 'express') {
            const resolved = drafts.resolve(toolArgs, owner);
            toolArgs = resolved.args;
            draftToken = resolved.token;
          }
          const { location } = toolArgs;
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
          const callWake = wakeAddress !== undefined && (owner === configuredOwner
            || wakeAddress.kind === 'paseo' && wakeAddress.address.agentId === baseEnv.PASEO_AGENT_ID
            || wakeAddress.kind === 'claude-native' && wakeAddress.address.sessionId === claude?.sessionId
            || wakeAddress.kind === 'opencode-server' && wakeAddress.address.sessionId === opencodeSessionId)
            ? wakeAddress : undefined;
          let text: string;
          try {
            expressAttempted = tool.name === 'express';
            text = await tool.run(square, toolArgs, { signal: extra.signal }, {
              owner, wakeAddress: claude === undefined && typeof threadId === 'string' && threadId.trim()
                ? codexWakeAddress(threadId, env) : callWake,
            });
            drafts.consume(draftToken);
          }
          finally { await square.close(); }
          return { content: [{ type: 'text' as const, text }] };
        } catch (error) {
          const failure = squareToolFailure(error, extra.signal);
          const participant = toolArgs.as;
          const draft = tool.name === 'express' ? drafts.retain(toolArgs, owner, draftToken, failure, expressAttempted) : undefined;
          return { isError: true, content: [{ type: 'text' as const, text: squareToolFailureText(failure, {
            location: square?.location ?? options.path,
            participant: typeof participant === 'string' ? participant : undefined,
            draft,
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
