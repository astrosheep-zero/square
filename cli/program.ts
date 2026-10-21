import { helpRequest } from '../help.js';
import { isSquareError } from '../model.js';
import type { OperationError } from '../square-facade.js';
import {
  commandPrefix, formatRefusal, refusalText, joinRecoveryCommand, participantIdentity,
  participantsRecoveryCommand, takeoverRecoveryLines,
} from '../presentation.js';
import { type CommandContext, withSquare, defaultContext, parseGlobalArgs } from './context.js';
import { executeRegisteredCommand, findCommand } from './registry.js';

async function handleSquareError(error: unknown, context?: CommandContext): Promise<never> {
  if (!isSquareError(error)) throw error;
  const detail = (error as OperationError).operation;
  const squarePath = context?.squarePath;
  const recovery = error.facts?.reason === 'migration_required' || context === undefined || squarePath === undefined ? undefined
    : await withSquare({ ...context, name: detail?.participant ?? context.name }, (square) => square.recovery(detail?.participant ?? context.name)).catch(() => undefined);
  const name = detail?.participant ?? recovery?.participant ?? context?.name;
  const existing = [refusalText(error)];
  if (error.facts?.reason === 'migration_required') {
    if (error.facts.ledgerRoot !== undefined) existing.push('square ledger migrate', 'square ledger verify');
    else if (squarePath !== undefined) existing.push(`${commandPrefix(squarePath)} migrate`);
  } else if (squarePath !== undefined && name !== undefined && error.code === 'already_joined') {
    existing.splice(0, 1, `✕ ${participantIdentity(name)} shoos you out of the square`,
      `  · ${participantIdentity(name)} already stands here — another session holds the name`);
    existing.push(...takeoverRecoveryLines(squarePath, name));
  } else if (squarePath !== undefined && error.facts?.reason === 'never_joined') {
    existing.push(detail?.subject !== 'filter' && name !== undefined
      ? joinRecoveryCommand(squarePath, name) : participantsRecoveryCommand(squarePath));
  } else if (squarePath !== undefined && error.facts?.reason === 'not_standing') {
    existing.push(participantsRecoveryCommand(squarePath));
  } else if (squarePath !== undefined && error.facts?.reason === 'not_addressed' && typeof error.facts.activityId === 'string') {
    existing.push(error.facts.activityExists === true
      ? `${commandPrefix(squarePath)} history --at ${error.facts.activityId} -C 2`
      : `${commandPrefix(squarePath)} history --limit 10`);
  }
  if (error.facts?.reason === 'invalid_done_body') existing.push('square done --help');
  if (squarePath === undefined) process.stderr.write(`${existing.join('\n')}\n`);
  else process.stderr.write(formatRefusal(squarePath, existing, {
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
