import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, runSquareTool, squareToolsEnabled } from './square-tools.js';
import { codexWakeAddress } from '../hosts/codex-address.js';
import { readClaudeMcpCall } from '../hosts/claude-mcp-context.js';
import { SQUARE_IDENTITY } from '../hosts/identity.js';
import { deliveryLedgerLocation, harnessOwner, type Owner } from '../api/square-api.js';
import { resolveParticipantIdentity, type AkumaActor } from '../hosts/participant-identity.js';
import type { SquareAtInput } from '../api/types.js';
import type { WakeAddress } from '../core/model.js';

/** Each tool call chooses its square and owns its connection lifetime. */
export interface SquareMcpOptions extends Omit<SquareAtInput, 'path'> {
  readonly env?: NodeJS.ProcessEnv;
  readonly owner?: Owner;
  readonly wakeAddress?: WakeAddress;
  /** Only a launcher-bound, single-actor stdio server can supply this. */
  readonly dedicatedActor?: AkumaActor;
}
export type SquareMcpServer = Server;

export function createSquareMcpServer(options: SquareMcpOptions): SquareMcpServer {
  const { owner: configuredOwner, wakeAddress, dedicatedActor, ...resourceOptions } = options;
  const baseEnv = { ...(resourceOptions.env ?? process.env) };
  const clock = resourceOptions.clock ?? Date.now;
  const ledgerLocation = resourceOptions.ledgerLocation ?? deliveryLedgerLocation(baseEnv);
  const toolsEnabled = squareToolsEnabled(baseEnv);
  const server = new Server({ name: 'square', version: SQUARE_IDENTITY.packageVersion }, toolsEnabled
    ? { instructions: SQUARE_TOOL_INSTRUCTIONS, capabilities: { tools: { listChanged: true } } } : {});
  if (!toolsEnabled) return server;
  // The high-level SDK handler would validate before Square can render the same refusal as the CLI.
  const tools = SQUARE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description,
    inputSchema: { ...z.toJSONSchema(inputSchema, { target: 'draft-7', io: 'input' }), type: 'object' as const } }));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const tool = SQUARE_TOOLS.find(tool => tool.name === params.name);
    if (tool === undefined) return { isError: true, content: [{ type: 'text' as const, text: `Tool ${params.name} not found` }] };
    return runSquareTool(tool, params.arguments ?? {}, { signal: extra.signal }, async () => {
        const threadId = extra._meta?.threadId;
        const opencodeSessionId = extra._meta?.['ai.opencode/sessionID'];
        // Claude's bundled mod requires a per-call native association; startup identity is not a fallback.
        const claude = baseEnv.SQUARE_CLAUDE_MCP_CONTEXT === '1'
          ? await readClaudeMcpCall(extra._meta?.['claudecode/toolUseId'], baseEnv)
          : undefined;
        const identity = resolveParticipantIdentity(claude === undefined ? dedicatedActor : claude.actor, () => {
          if (claude === undefined && typeof threadId === 'string' && threadId.trim()) {
            return { owner: harnessOwner({ channel: 'codex', session: threadId }),
              wakeAddress: { ...codexWakeAddress(threadId, baseEnv), kind: 'codex-queue' as const } };
          }
          const owner = claude !== undefined
            ? harnessOwner({ channel: 'claude-code', session: claude.sessionId, agent: claude.agentId })
            : typeof opencodeSessionId === 'string' && opencodeSessionId.trim()
              ? harnessOwner({ channel: 'opencode', session: opencodeSessionId }) : configuredOwner;
          const callWake = wakeAddress !== undefined && (owner === configuredOwner
            || wakeAddress.kind === 'paseo' && wakeAddress.address.agentId === baseEnv.PASEO_AGENT_ID
            || wakeAddress.kind === 'opencode-server' && wakeAddress.address.sessionId === opencodeSessionId)
            ? wakeAddress : undefined;
          return { owner, wakeAddress: callWake };
        });
        return { identity, cwd: claude?.cwd ?? resourceOptions.cwd, ledgerLocation, clock };
      }).then(({ text, isError }) => ({
        ...(isError ? { isError } : {}), content: [{ type: 'text' as const, text }],
      }));
  });
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
