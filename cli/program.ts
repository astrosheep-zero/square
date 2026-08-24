import { helpRequest } from '../help.js';
import { isSquareError } from '../model.js';

import { defaultContext, parseGlobalArgs } from './context.js';
import { executeRegisteredCommand, findCommand } from './registry.js';

function handleSquareError(error: unknown): never {
  if (isSquareError(error)) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.code === 'not_found' ? 1 : 2);
  }
  throw error;
}

/** Parse global flags, select an executable adapter, and leave all command work to the registry. */
export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  try {
    const requestedHelp = helpRequest(rawArgs);
    if (requestedHelp !== undefined) {
      await executeRegisteredCommand('help', requestedHelp.command === undefined ? [] : [requestedHelp.command], defaultContext('help'));
      return;
    }

    const parsed = parseGlobalArgs(rawArgs);
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
    handleSquareError(error);
  }
}
