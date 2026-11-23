import { buildCommand } from './square-commands.js';
import { CLI_OPERATIONS } from '../surfaces/operations.js';
import { operationCommand } from './operation-command.js';
import { doctorCommand, migrateCommand } from './maintenance-commands.js';
import { type CommandContext, type CommandSpec } from './context.js';
import { harnessCommand, installCommand, uninstallCommand } from './harness-command.js';
import { helpCommand, versionCommand } from './meta-commands.js';
import { mcpServerCommand } from './mcp-server-command.js';
import { claudeModCommand, codexHookCommand, codexWatchCommand, codexInterruptCommand, inboxCommand, streamCommand } from './observation-commands.js';

export interface RegisteredCommand {
  names: readonly string[];
  spec: CommandSpec<any, any>;
}

/** Every public command is an executable adapter, including aliases and utility commands. */
export const commands: readonly RegisteredCommand[] = [
  ...CLI_OPERATIONS.map(cli => ({ names: cli.names, spec: operationCommand(cli) })),
  { names: ['build'], spec: buildCommand },
  { names: ['stream'], spec: streamCommand },
  { names: ['inbox'], spec: inboxCommand },
  { names: ['claude-mod'], spec: claudeModCommand },
  { names: ['codex-hook'], spec: codexHookCommand },
  { names: ['codex-watch'], spec: codexWatchCommand },
  { names: ['codex-interrupt'], spec: codexInterruptCommand },
  { names: ['install'], spec: installCommand },
  { names: ['uninstall'], spec: uninstallCommand },
  { names: ['harness'], spec: harnessCommand },
  { names: ['doctor'], spec: doctorCommand },
  { names: ['migrate'], spec: migrateCommand },
  { names: ['help'], spec: helpCommand },
  { names: ['version', '--version', '-v'], spec: versionCommand },
  { names: ['mcp-server'], spec: mcpServerCommand },
];

export function findCommand(name: string): RegisteredCommand | undefined {
  return commands.find((command) => command.names.includes(name));
}

export async function executeRegisteredCommand(name: string, argv: string[], context: CommandContext): Promise<void> {
  const command = findCommand(name);
  if (command === undefined) throw new Error(`No registered command named ${name}`);
  const intent = command.spec.parse(argv, context);
  const result = await command.spec.execute(intent, context);
  command.spec.present(result, context);
}
