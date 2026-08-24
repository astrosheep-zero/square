import { buildCommand, doneCommand, expressCommand, holdCommand, ignoreCommand, joinCommand, listenCommand, listeningCommand, resumeCommand } from './square-commands.js';
import { doctorCommand } from './maintenance-commands.js';
import { type CommandContext, type CommandSpec } from './context.js';
import { harnessCommand, installCommand, uninstallCommand } from './harness-command.js';
import { helpCommand, versionCommand } from './meta-commands.js';
import {
  catchCommand,
  claudeHookCommand,
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
  { names: ['claude-hook'], spec: claudeHookCommand },
  { names: ['codex-hook'], spec: codexHookCommand },
  { names: ['catch'], spec: catchCommand },
  { names: ['express'], spec: expressCommand },
  { names: ['listen'], spec: listenCommand },
  { names: ['ignore'], spec: ignoreCommand },
  { names: ['listening'], spec: listeningCommand },
  { names: ['done'], spec: doneCommand },
  { names: ['hold'], spec: holdCommand },
  { names: ['resume'], spec: resumeCommand },
  { names: ['install'], spec: installCommand },
  { names: ['uninstall'], spec: uninstallCommand },
  { names: ['harness'], spec: harnessCommand },
  { names: ['doctor'], spec: doctorCommand },
  { names: ['history'], spec: historyCommand },
  { names: ['status'], spec: statusCommand },
  { names: ['participants'], spec: participantsCommand },
  { names: ['help'], spec: helpCommand },
  { names: ['version', '--version', '-v'], spec: versionCommand },
];

export function findCommand(name: string): RegisteredCommand | undefined {
  return commandRegistry.find((command) => command.names.includes(name));
}

export async function executeRegisteredCommand(name: string, argv: string[], context: CommandContext): Promise<void> {
  const command = findCommand(name);
  if (command === undefined) throw new Error(`No registered command named ${name}`);
  const intent = command.spec.parse(argv, context);
  const result = await command.spec.execute(intent, context);
  command.spec.present(result, context);
}
