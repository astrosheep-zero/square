import { helpRequest } from '../help.js';
import { isSquareError } from '../model.js';
import { formatRefusal, joinRecoveryCommand, participantsRecoveryCommand, takeoverRecoveryLines } from '../presentation.js';
import { inSquareCount, nowMs } from '../runtime.js';
import { openSquare } from '../square-file-adapter.js';
import { closeOpenSquare } from '../open-square.js';

import { defaultContext, parseGlobalArgs } from './context.js';
import { executeRegisteredCommand, findCommand } from './registry.js';

async function participantCountFor(squarePath: string): Promise<number | undefined> {
  try {
    const square = await openSquare(squarePath, { clock: nowMs });
    try {
      return inSquareCount((await square.artifact.read()).state);
    } finally {
      await closeOpenSquare(square);
    }
  } catch {
    return undefined;
  }
}

async function handleSquareError(error: unknown, squarePath?: string, name?: string): Promise<never> {
  if (isSquareError(error)) {
    const existing = [error.message];
    if (squarePath !== undefined && name !== undefined && error.code === 'already_joined') {
      existing.push(...takeoverRecoveryLines(squarePath, name));
    } else if (squarePath !== undefined && error.facts?.reason === 'never_joined') {
      // The caller's name has never joined this square; only a join admits it.
      if (name !== undefined) existing.push(joinRecoveryCommand(squarePath, name));
      else existing.push(participantsRecoveryCommand(squarePath));
    } else if (squarePath !== undefined && error.facts?.reason === 'not_standing') {
      existing.push(participantsRecoveryCommand(squarePath));
    }
    if (squarePath === undefined) {
      process.stderr.write(`${existing.join('\n')}\n`);
    } else {
      const participantCount = await participantCountFor(squarePath);
      process.stderr.write(formatRefusal(squarePath, existing, participantCount === undefined ? {} : { participantCount }));
    }
    process.exit(error.code === 'not_found' ? 1 : 2);
  }
  throw error;
}

/** Parse global flags, select an executable adapter, and leave all command work to the registry. */
export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  let squarePath: string | undefined;
  let requestedName: string | undefined;
  try {
    const requestedHelp = helpRequest(rawArgs);
    if (requestedHelp !== undefined) {
      await executeRegisteredCommand('help', requestedHelp.command === undefined ? [] : [requestedHelp.command], defaultContext('help'));
      return;
    }

    const parsed = await parseGlobalArgs(rawArgs);
    squarePath = parsed.squarePath;
    requestedName = parsed.name;
    if (parsed.args.length === 0 || parsed.args[0] === '--help' || parsed.args[0] === '-h') {
      await executeRegisteredCommand('help', [], defaultContext('help', parsed.squarePath, parsed.name));
      return;
    }
    const command = parsed.args[0];
    if (findCommand(command) === undefined) {
      process.stderr.write(`unknown command: ${command}\nrun 'square' for usage\n`);
      process.exit(2);
    }
    await executeRegisteredCommand(command, parsed.args.slice(1), defaultContext(command, parsed.squarePath, parsed.name));
  } catch (error) {
    await handleSquareError(error, squarePath, requestedName);
  }
}
