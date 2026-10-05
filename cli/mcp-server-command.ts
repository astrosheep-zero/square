import { type CommandContext, type CommandSpec, fail } from './context.js';

export const mcpServerCommand: CommandSpec<undefined, void> = {
  parse(argv) {
    if (argv.length > 0) fail('Usage: square [--location <square>] [--as <name>] mcp-server');
    return undefined;
  },
  async execute(_intent, context: CommandContext) {
    const { runSquareMcpStdio } = await import('../mcp.js');
    await runSquareMcpStdio({ cwd: context.cwd, env: context.env, squarePath: context.squarePath, participant: context.name });
  },
  present() {},
};
