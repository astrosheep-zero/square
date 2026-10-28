import { type BuildOptions, type HardCap, formatHardCap } from '../model.js';
import type { Reach, ActivityMetadata } from '../square-facade.js';
import {
  commandPrefix,
  participantCommandPrefix,
  withPathOutput,
} from '../presentation.js';
import {
  renderJoinResult,
  renderLifecycleResult,
  renderListenerChange,
  renderListeningResult,
} from '../operation-presentation.js';
import { Square } from '../square-api.js';
import { executeExpression } from './express-presentation.js';
import { jsonResult } from './json.js';
import {
  type CommandContext, type CommandSpec, squareInput, withSquare, fail, parseBoundedLimit,
  parseHardCap, parsePositiveInteger, readStdin, requireSquarePath, requireValue,
  resolveBody, usage,
} from './context.js';

interface BuildIntent {
  options: BuildOptions & { hardCap: HardCap };
}
interface JoinIntent {
  lastN: number;
  kick: boolean;
}
interface ActivityIntent {
  activity?: string;
  force: boolean;
  noWait: boolean;
  noMention: boolean;
  mentions: string[];
  reach?: Reach;
  reply?: string;
  metadata?: ActivityMetadata;
  metadataJson?: string;
}
interface BodyIntent {
  body?: string;
}
interface ListenerIntent {
  target?: string;
}
const JOIN_DEFAULT_LAST = 10;
const JOIN_MAX_LAST = 100;

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
      participantCount: 0, held: false,
    });
  },
  present: (result) => process.stdout.write(result),
};

export const joinCommand: CommandSpec<JoinIntent, string> = {
  parse(argv, context) {
    let lastN = JOIN_DEFAULT_LAST;
    let kick = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--last') {
        lastN = parseBoundedLimit(argv[index + 1], '--last', JOIN_MAX_LAST,
          `${context.name === undefined ? commandPrefix(requireSquarePath(context)) : participantCommandPrefix(requireSquarePath(context), context.name)} join --last ${JOIN_MAX_LAST}`);
        index += 1;
      } else if (argv[index] === '--kick') kick = true;
      else if (argv[index] !== '--json') usage(context.command);
    }
    return { lastN, kick };
  },
  async execute(intent, context) {
    const data = await withSquare(context, (square) => square.join(context.name, {
      takeover: intent.kick, last: intent.lastN, ...(context.json ? {} : { observe: true }),
    }));
    return context.json ? jsonResult(data) : renderJoinResult(data)!;
  },
  present: (result) => process.stdout.write(result),
};

function parseActivity(argv: string[], context: CommandContext): ActivityIntent {
  let force = false;
  let noWait = false;
  let bell = false;
  let noMention = false;
  const mentions: string[] = [];
  let reply: string | undefined;
  let metadata: ActivityMetadata | undefined;
  let metadataJson: string | undefined;
  const bodyArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--json') continue;
    if (argument === '-f' || argument === '--force') force = true;
    else if (argument === '--no-wait') noWait = true;
    else if (argument === '--beside') fail('✕ express does not know --beside\nsquare express --help');
    else if (argument === '--bell') bell = true;
    else if (argument === '--no-mention') noMention = true;
    else if (argument === '--mention') {
      mentions.push(requireValue(argv, index, argument));
      index += 1;
    } else if (argument === '--reply') {
      reply = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--metadata') {
      metadataJson = requireValue(argv, index, argument);
      try { metadata = JSON.parse(metadataJson) as ActivityMetadata; }
      catch { fail('✕ invalid --metadata: expected JSON'); }
      index += 1;
    }
    else bodyArgs.push(argument);
  }
  const reach = bell ? 'bell' : undefined;
  if (bodyArgs.length > 1) fail("express accepts one body argument (a quoted string or '-')");
  if (bodyArgs.length === 0 && metadataJson === undefined) {
    if (!process.stdin.isTTY) bodyArgs.push('-');
    else fail("express requires a body argument or --metadata <json>");
  }
  return { activity: bodyArgs[0], force, noWait, noMention, mentions, reach, reply, metadata, metadataJson };
}

export const expressCommand: CommandSpec<ActivityIntent> = {
  parse: parseActivity,
  async execute(intent, context) {
    const rawInput = intent.activity === undefined ? undefined : await resolveBody(intent.activity);
    await executeExpression((control) => Square.at(squareInput(context), control), requireSquarePath(context), context.name, rawInput, {
      force: intent.force, noWait: intent.noWait, noMention: intent.noMention,
      mentions: intent.mentions, reach: intent.reach, reply: intent.reply, metadata: intent.metadata,
      metadataJson: intent.metadataJson, bodyProvided: intent.activity !== undefined,
    }, context.json);
  },
  present: () => {},
};

function parseListener(argv: string[], context: CommandContext, targetRequired: boolean): ListenerIntent {
  const args = argv.filter((arg) => arg !== '--json');
  if (targetRequired ? args.length !== 1 : args.length !== 0) usage(context.command);
  return targetRequired ? { target: args[0] } : {};
}

function listenerCommand(verb: 'listen' | 'ignore' | 'unlisten'): CommandSpec<ListenerIntent, string> {
  return {
    parse(argv, context) { return parseListener(argv, context, true); },
    async execute(intent, context) {
      const squarePath = requireSquarePath(context);
      const data = await withSquare(context, async (square) => (await square.participant(context.name))[verb](intent.target!, context.json ? {} : { observe: true }));
      return context.json ? jsonResult(data) : renderListenerChange(squarePath, verb, data)!;
    },
    present: (result) => process.stdout.write(result),
  };
}
export const listenCommand = listenerCommand('listen');
export const ignoreCommand = listenerCommand('ignore');
export const unlistenCommand = listenerCommand('unlisten');
export const listeningCommand: CommandSpec<ListenerIntent, string> = {
  parse(argv, context) { return parseListener(argv, context, false); },
  async execute(_intent, context) {
    const squarePath = requireSquarePath(context);
    const data = await withSquare(context, async (square) => (await square.participant(context.name)).listening(context.json ? {} : { observe: true }));
    return context.json ? jsonResult(data) : renderListeningResult(squarePath, data)!;
  },
  present: (result) => process.stdout.write(result),
};

function lifecycleCommand(verb: 'done' | 'hold' | 'resume'): CommandSpec<BodyIntent, string> {
  return {
    parse(argv, context) {
      const args = argv.filter((arg) => arg !== '--json');
      if (args.length > (verb === 'resume' ? 0 : 1)) usage(context.command);
      return { body: args[0] };
    },
    async execute(intent, context) {
      const body = verb === 'hold' ? (await resolveBody(intent.body ?? '')).replace(/\r\n/g, '\n').trim()
        : verb === 'done' && (intent.body === '-' || ((intent.body === undefined || intent.body === '') && !process.stdin.isTTY))
          ? await readStdin() : intent.body;
      const squarePath = requireSquarePath(context);
      const result = await withSquare(context, async (square) => {
        const participant = await square.participant(context.name);
        const options = context.json ? {} : { observe: true };
        return verb === 'resume' ? participant.resume(options) : participant[verb](body, options);
      });
      return context.json ? jsonResult(result) : renderLifecycleResult(squarePath, verb, result)!;
    },
    present: (result) => process.stdout.write(result),
  };
}
export const doneCommand = lifecycleCommand('done');
export const holdCommand = lifecycleCommand('hold');
export const resumeCommand = lifecycleCommand('resume');
