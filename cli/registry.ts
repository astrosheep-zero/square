import { buildCommand, doneCommand, expressCommand, ignoreCommand, joinCommand, listenCommand, listeningCommand, unlistenCommand } from './square-commands.js';
import { doctorCommand, migrateCommand } from './maintenance-commands.js';
import { type CommandContext, type CommandSpec } from './context.js';
import { harnessCommand, installCommand, uninstallCommand } from './harness-command.js';
import { helpCommand, versionCommand } from './meta-commands.js';
import { mcpServerCommand } from './mcp-server-command.js';
import { JSON_COMMANDS } from './json.js';
import {
  catchCommand,
  claudeModCommand,
  codexHookCommand,
  historyCommand,
  inboxCommand,
  listCommand,
  participantsCommand,
  statusCommand,
  streamCommand,
} from './observation-commands.js';

export interface RegisteredCommand {
  names: readonly string[];
  spec: CommandSpec<any, any>;
}

/** Every public command is an executable adapter, including aliases and utility commands. */
export const commandRegistry: readonly RegisteredCommand[] = [
  { names: ['build'], spec: buildCommand },
  { names: ['list', 'ls'], spec: listCommand },
  { names: ['join'], spec: joinCommand },
  { names: ['stream'], spec: streamCommand },
  { names: ['inbox'], spec: inboxCommand },
  { names: ['claude-mod'], spec: claudeModCommand },
  { names: ['codex-hook'], spec: codexHookCommand },
  { names: ['catch'], spec: catchCommand },
  { names: ['express'], spec: expressCommand },
  { names: ['listen'], spec: listenCommand },
  { names: ['ignore'], spec: ignoreCommand },
  { names: ['unlisten'], spec: unlistenCommand },
  { names: ['listening'], spec: listeningCommand },
  { names: ['done'], spec: doneCommand },
  { names: ['install'], spec: installCommand },
  { names: ['uninstall'], spec: uninstallCommand },
  { names: ['harness'], spec: harnessCommand },
  { names: ['doctor'], spec: doctorCommand },
  { names: ['migrate'], spec: migrateCommand },
  { names: ['history'], spec: historyCommand },
  { names: ['status'], spec: statusCommand },
  { names: ['participants'], spec: participantsCommand },
  { names: ['help'], spec: helpCommand },
  { names: ['version', '--version', '-v'], spec: versionCommand },
  { names: ['mcp-server'], spec: mcpServerCommand },
];

export function findCommand(name: string): RegisteredCommand | undefined {
  return commandRegistry.find((command) => command.names.includes(name));
}

export async function executeRegisteredCommand(name: string, argv: string[], context: CommandContext): Promise<void> {
  const command = findCommand(name);
  if (command === undefined) throw new Error(`No registered command named ${name}`);
  const json = JSON_COMMANDS.has(name) && argv.includes('--json');
  const options = json ? { ...context, json } : context;
  const intent = command.spec.parse(argv, options);
  const result = await command.spec.execute(intent, options);
  command.spec.present(result, options);
}
