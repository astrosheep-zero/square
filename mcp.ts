import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, createSquareToolRunner, squareToolsEnabled } from './square-tools.js';
import { operationEnv } from './participant-identity.js';
import { codexWakeAddress } from './codex-address.js';
import { readClaudeMcpCall } from './claude-mcp-context.js';
import { SQUARE_IDENTITY } from './identity.js';
import { Square, discover, squareClock } from './square-api.js';
import { harnessOwner, type Owner } from './square-api.js';
import type { SquareAtInput } from './square-facade.js';
import type { WakeAddress } from './model.js';

/** Each tool call chooses its square and owns its connection lifetime. */
export interface SquareMcpOptions extends Omit<SquareAtInput, 'path'> {
  readonly owner?: Owner;
  readonly wakeAddress?: WakeAddress;
}
export type SquareMcpServer = McpServer;

export function createSquareMcpServer(options: SquareMcpOptions): SquareMcpServer {
  const { owner: configuredOwner, wakeAddress, ...resourceOptions } = options;
  const baseEnv = { ...(resourceOptions.env ?? process.env) };
  const toolsEnabled = squareToolsEnabled(baseEnv);
  const invoke = createSquareToolRunner();
  const server = new McpServer({ name: 'square', version: SQUARE_IDENTITY.packageVersion }, {
    ...(toolsEnabled ? { instructions: SQUARE_TOOL_INSTRUCTIONS } : {}),
  });
  if (toolsEnabled) for (const tool of SQUARE_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args, extra) => {
      return invoke(tool, args, { signal: extra.signal }, async () => {
        const threadId = extra._meta?.threadId;
        const opencodeSessionId = extra._meta?.['ai.opencode/sessionID'];
        // Claude's bundled plugin requires a per-call native hook association; startup identity is not a fallback.
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
        const env = claude !== undefined
          ? { ...operationEnv('claude', claude.sessionId, baseEnv),
            // An agent loop ID is not a session ID.
            CLAUDE_CODE_CHILD_SESSION: claude.agentId === undefined ? '' : '1' }
          : typeof threadId === 'string' && threadId.trim()
            ? operationEnv('codex', threadId, baseEnv)
            : typeof opencodeSessionId === 'string' && opencodeSessionId.trim()
              ? operationEnv('opencode', opencodeSessionId, baseEnv)
              : baseEnv;
        const callWake = wakeAddress !== undefined && (owner === configuredOwner
          || wakeAddress.kind === 'paseo' && wakeAddress.address.agentId === baseEnv.PASEO_AGENT_ID
          || wakeAddress.kind === 'opencode-server' && wakeAddress.address.sessionId === opencodeSessionId)
          ? wakeAddress : undefined;
        return {
          identity: { owner, wakeAddress: claude === undefined && typeof threadId === 'string' && threadId.trim()
            ? { ...codexWakeAddress(threadId, env), kind: 'codex-queue' as const } : callWake },
          open: (location, control) => Square.at({ ...resourceOptions, env, cwd: claude?.cwd ?? resourceOptions.cwd, path: location }, control),
          discover: async (discovery, control) => ({
            result: await discover({ ...resourceOptions, env, cwd: claude?.cwd ?? resourceOptions.cwd }, discovery, control),
            now: squareClock(env, resourceOptions.clock)(),
          }),
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
