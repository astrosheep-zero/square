import { type BuildOptions, type HardCap, formatHardCap } from '../core/model.js';
import { withPathOutput } from '../surfaces/presentation.js';
import { Square } from '../api/square-api.js';
import { type CommandSpec, squareInput, fail, parseHardCap, parsePositiveInteger, readStdin, requireValue } from './context.js';

interface BuildIntent {
  options: BuildOptions & { hardCap: HardCap };
}

export const buildCommand: CommandSpec<BuildIntent, string> = {
  parse(argv) {
    const options: BuildIntent['options'] = { force: false, hardCap: null };
    for (let index = 0; index < argv.length; index++) {
      const flag = argv[index];
      switch (flag) {
        case '--cap':
          options.hardCap = parseHardCap(requireValue(argv, index, flag));
          index += 1;
          break;
        case '--template':
          options.template = requireValue(argv, index, flag);
          index += 1;
          break;
        case '--throttle':
        case '--throttle-per-minute':
          options.throttlePerMinute = parsePositiveInteger(requireValue(argv, index, flag), flag);
          index += 1;
          break;
        case '--force':
        case '-f':
          options.force = true;
          break;
        default:
          fail(`Unknown build option: ${flag}`);
      }
    }
    if (options.template !== undefined && !/^[a-zA-Z0-9-]+$/.test(options.template)) {
      fail('Invalid template name: only letters, digits, and hyphens allowed.');
    }
    return { options };
  },
  async execute(intent, context) {
    const markdown = await readStdin();
    if (markdown.trim() === '') fail('Missing Markdown body snippet on stdin.');
    const square = await Square.build({ ...squareInput(context), ...intent.options, markdown });
    let data;
    try { data = await square.status(); }
    finally { await square.close(); }
    const cap = data.hardCap === null ? 'unlimited' : formatHardCap(data.hardCap);
    const throttle = data.throttlePerMinute === undefined ? [] : [`  · throttle ${data.throttlePerMinute}/min`];
    return withPathOutput(square.location, ['· the square stands ready', `  · cap ${cap}`, ...throttle].join('\n'), {
      participantCount: 0,
    });
  },
  present: (result) => process.stdout.write(result),
};
