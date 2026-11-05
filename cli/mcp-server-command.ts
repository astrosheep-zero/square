import { type CommandContext, type CommandSpec, fail, commandIdentity } from './context.js';

export const mcpServerCommand: CommandSpec<undefined, void> = {
  parse(argv) {
    if (argv.length > 0) fail('Usage: square mcp-server');
    return undefined;
  },
  async execute(_intent, context: CommandContext) {
    const { runSquareMcpStdio } = await import('../mcp.js');
    await runSquareMcpStdio({ cwd: context.cwd, env: context.env, ...commandIdentity(context.env, context.owner) });
  },
  present() {},
};
