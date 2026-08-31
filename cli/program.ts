import { helpRequest } from '../help.js';
import { isSquareError } from '../model.js';
import { commandPrefix } from '../presentation.js';

import { defaultContext, parseGlobalArgs } from './context.js';
import { executeRegisteredCommand, findCommand } from './registry.js';

function handleSquareError(error: unknown, squarePath?: string): never {
  if (isSquareError(error)) {
    process.stderr.write(`${error.message}\n`);
    if (squarePath !== undefined && /^(Unknown participant|Unknown mention target)/.test(error.message)) {
      process.stderr.write(`» ${commandPrefix(squarePath)} participants\n`);
    }
    process.exit(error.code === 'not_found' ? 1 : 2);
  }
  throw error;
}

/** Parse global flags, select an executable adapter, and leave all command work to the registry. */
export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  let squarePath: string | undefined;
  try {
    const requestedHelp = helpRequest(rawArgs);
    if (requestedHelp !== undefined) {
      await executeRegisteredCommand('help', requestedHelp.command === undefined ? [] : [requestedHelp.command], defaultContext('help'));
      return;
    }

    const parsed = await parseGlobalArgs(rawArgs);
    squarePath = parsed.squarePath;
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
    handleSquareError(error, squarePath);
  }
}
