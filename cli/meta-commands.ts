import { renderGlobalHelp, renderSubcommandHelp } from '../help.js';
import { SQUARE_IDENTITY } from '../identity.js';

import { type CommandSpec, fail } from './context.js';

export const helpCommand: CommandSpec<{ command?: string }, string> = {
  parse(argv) {
    if (argv.length > 1) fail('Usage: square help [command]');
    return { command: argv[0] };
  },
  execute(intent) {
    if (intent.command === undefined) return renderGlobalHelp();
    const rendered = renderSubcommandHelp(intent.command);
    if (rendered === undefined) fail(`unknown command: ${intent.command}\nrun 'square help' to list available commands`);
    return rendered;
  },
  present: (result) => process.stdout.write(result),
};

export const versionCommand: CommandSpec<undefined, string> = {
  parse() {
    return undefined;
  },
  execute() {
    return `${SQUARE_IDENTITY.packageVersion}\n`;
  },
  present: (result) => process.stdout.write(result),
};
