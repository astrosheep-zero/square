import { helpRequest } from '../help.js';
import { isSquareError } from '../model.js';
import type { OperationError } from '../square-facade.js';
import { formatRefusal } from '../presentation.js';
import { renderFailureLines } from '../operation-presentation.js';
import { type CommandContext, withSquare, defaultContext, parseGlobalArgs } from './context.js';
import { executeRegisteredCommand, findCommand } from './registry.js';

async function handleSquareError(error: unknown, context?: CommandContext): Promise<never> {
  if (!isSquareError(error)) throw error;
  const detail = (error as OperationError).operation;
  const squarePath = context?.squarePath;
  const recovery = error.facts?.reason === 'migration_required' || context === undefined || squarePath === undefined ? undefined
    : await withSquare({ ...context, name: detail?.participant ?? context.name }, (square) => square.recovery(detail?.participant ?? context.name)).catch(() => undefined);
  const name = detail?.participant ?? recovery?.participant ?? context?.name;
  const lines = renderFailureLines(error, { squarePath, name });
  if (squarePath === undefined) process.stderr.write(`${lines.join('\n')}\n`);
  else process.stderr.write(formatRefusal(squarePath, lines, {
    participantCount: recovery?.standingCount, held: recovery?.held,
  }));
  process.exit(error.code === 'not_found' ? 1 : 2);
}

/** Parse global flags, select an adapter, and execute through Square/Participant. */
export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  let context: CommandContext | undefined;
  try {
    const requestedHelp = helpRequest(rawArgs);
    if (requestedHelp !== undefined) {
      await executeRegisteredCommand('help', requestedHelp.command === undefined ? [] : [requestedHelp.command], defaultContext('help'));
      return;
    }
    const parsed = await parseGlobalArgs(rawArgs);
    const command = parsed.args[0];
    context = defaultContext(command ?? 'help', parsed.squarePath, parsed.name);
    if (command === undefined || command === '--help' || command === '-h') {
      await executeRegisteredCommand('help', [], context);
      return;
    }
    if (findCommand(command) === undefined) {
      process.stderr.write(`unknown command: ${command}\nrun 'square' for usage\n`);
      process.exit(2);
    }
    await executeRegisteredCommand(command, parsed.args.slice(1), context);
  } catch (error) { await handleSquareError(error, context); }
}
