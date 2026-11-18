import { type CommandContext, type CommandSpec, fail, nativeCommandIdentity } from './context.js';
import { akumaActorFromEnvironment } from '../participant-identity.js';

export const mcpServerCommand: CommandSpec<undefined, void> = {
  parse(argv) {
    if (argv.length > 0) fail('Usage: square mcp-server');
    return undefined;
  },
  async execute(_intent, context: CommandContext) {
    const { runSquareMcpStdio } = await import('../mcp.js');
    const { cwd, env } = context;
    // A bundled Claude server is shared even when its process inherited a pair.
    if (env.SQUARE_CLAUDE_MCP_CONTEXT === '1') return runSquareMcpStdio({ cwd, env });
    const owner = context.owner ?? env.SQUARE_OWNER;
    if (owner !== undefined) return runSquareMcpStdio({ cwd, env, owner });
    const dedicatedActor = akumaActorFromEnvironment(env);
    await runSquareMcpStdio({ cwd, env, ...(dedicatedActor === undefined ? nativeCommandIdentity(env) : { dedicatedActor }) });
  },
  present() {},
};
