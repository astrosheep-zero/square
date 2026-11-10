import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, createSquareToolRunner, squareToolsEnabled } from './square-tools.js';
import { codexWakeAddress } from './codex-address.js';
import { readClaudeMcpCall } from './claude-mcp-context.js';
import { SQUARE_IDENTITY } from './identity.js';
import { Square, discover } from './square-api.js';
import { harnessOwner, type Owner } from './square-api.js';
import type { SquareAtInput } from './square-facade.js';
import type { WakeAddress } from './model.js';

/** Each tool call chooses its square and owns its connection lifetime. */
export interface SquareMcpOptions extends Omit<SquareAtInput, 'path'> {
  readonly env?: NodeJS.ProcessEnv;
  readonly owner?: Owner;
  readonly wakeAddress?: WakeAddress;
}
export type SquareMcpServer = Server;

export function createSquareMcpServer(options: SquareMcpOptions): SquareMcpServer {
  const { owner: configuredOwner, wakeAddress, ...resourceOptions } = options;
  const baseEnv = { ...(resourceOptions.env ?? process.env) };
  const toolsEnabled = squareToolsEnabled(baseEnv);
  const invoke = createSquareToolRunner();
  const server = new Server({ name: 'square', version: SQUARE_IDENTITY.packageVersion }, {
    capabilities: toolsEnabled ? { tools: {} } : {},
    ...(toolsEnabled ? { instructions: SQUARE_TOOL_INSTRUCTIONS } : {}),
  });
  if (toolsEnabled) {
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: SQUARE_TOOLS.map(tool => ({
      name: tool.name, description: tool.description,
        inputSchema: { ...z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }), type: 'object' as const },
    })) }));
    // The runner restores an express draft before validating its required body and location.
    server.setRequestHandler(CallToolRequestSchema, ({ params }, extra) => {
      const tool = SQUARE_TOOLS.find(tool => tool.name === params.name);
      if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
      return invoke(tool, params.arguments ?? {}, { signal: extra.signal }, async () => {
        const threadId = extra._meta?.threadId;
        const opencodeSessionId = extra._meta?.['ai.opencode/sessionID'];
        // Claude's bundled mod requires a per-call native association; startup identity is not a fallback.
        const claude = baseEnv.SQUARE_CLAUDE_MCP_CONTEXT === '1'
          ? await readClaudeMcpCall(extra._meta?.['claudecode/toolUseId'], baseEnv)
          : undefined;
        const owner = claude !== undefined
          ? harnessOwner({ channel: 'claude-code', session: claude.sessionId, ...(claude.agentId === undefined ? {} : { agent: claude.agentId }) })
          : typeof threadId === 'string' && threadId.trim()
            ? harnessOwner({ channel: 'codex', session: threadId })
            : typeof opencodeSessionId === 'string' && opencodeSessionId.trim()
              ? harnessOwner({ channel: 'opencode', session: opencodeSessionId })
              : configuredOwner;
        const callWake = wakeAddress !== undefined && (owner === configuredOwner
          || wakeAddress.kind === 'paseo' && wakeAddress.address.agentId === baseEnv.PASEO_AGENT_ID
          || wakeAddress.kind === 'opencode-server' && wakeAddress.address.sessionId === opencodeSessionId)
          ? wakeAddress : undefined;
        const clock = resourceOptions.clock ?? Date.now;
        return {
          identity: { owner, wakeAddress: claude === undefined && typeof threadId === 'string' && threadId.trim()
            ? { ...codexWakeAddress(threadId, baseEnv), kind: 'codex-queue' as const } : callWake },
          now: clock,
          open: (location, control) => Square.at({ ...resourceOptions, cwd: claude?.cwd ?? resourceOptions.cwd, path: location, clock }, control),
          discover: (discovery, control) => discover({ cwd: claude?.cwd ?? resourceOptions.cwd }, discovery, control),
        };
      }).then(({ text, isError }) => ({
        ...(isError ? { isError } : {}), content: [{ type: 'text' as const, text }],
      }));
    });
  }
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
