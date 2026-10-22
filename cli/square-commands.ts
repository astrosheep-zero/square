import { type BuildOptions, type HardCap, type RoomChangeAct, formatHardCap } from '../model.js';
import type { Reach } from '../square-facade.js';
import {
  commandPrefix,
  participantCommandPrefix,
  participantIdentity,
  renderRoomChangeText,
  renderAmbientEvent,
  withPathOutput,
} from '../presentation.js';
import { Square, formatActivityId } from '../square-api.js';
import { style } from '../tty-style.js';
import { executeExpression } from './express-presentation.js';
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
  activity: string;
  force: boolean;
  noWait: boolean;
  noMention: boolean;
  mentions: string[];
  reach?: Reach;
  reply?: string;
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
      else usage(context.command);
    }
    return { lastN, kick };
  },
  async execute(intent, context) {
    const data = await withSquare(context, (square) => square.join(context.name, { takeover: intent.kick, last: intent.lastN, observe: true }));
    const after = data.observation!;
    const entry = after.entry;
    const name = data.participant.name;
    const activities = (entry?.recentActivities ?? []).map((event) => renderAmbientEvent(event, name, {
      now: after.now, preview: 200,
      actNumber: event.kind === 'say' ? entry!.sayNumbers[event.index] : undefined,
      perception: entry!.perceptions[event.index],
    })).filter(Boolean).join('\n\n');
    const fallback = after.automaticDeliveryAvailable ? [] : [
      '', `${participantCommandPrefix(after.location, name)} catch --idle 30m`,
      '  the square has no way to call you — keep this catch open and stay within earshot',
    ];
    const entryLine = data.kind === 'joined' ? '● you stepped into the square'
      : data.kind === 'reconnected' ? '● you are already in the square'
        : `✓ you banished the original ${participantIdentity(name)} — the name is yours`;
    const isRejoin = data.kind !== 'joined';
    const entryScene = isRejoin || entry === undefined ? '' : entry.joinedBefore
      ? '*the flagstones are where you left them. so is your shadow.*' : entry.scene;
    return withPathOutput(after.location, [
      entryLine, '',
      "· carved into the fountain's edge: every word here lands on a real ear — speak when someone needs it.",
      ...(entryScene === '' ? [] : ['', entryScene]),
      ...(isRejoin || !entry?.joinContext ? [] : ['', style('dim', 'context'), entry.joinContext]),
      ...(after.enrichmentUnavailable ? ['  · joined; recent activity and context are unavailable right now'] : []),
      ...(isRejoin || activities === '' ? [] : ['', style('dim', 'recent activity'), activities]),
      ...fallback,
    ].join('\n'), { participantCount: after.standingCount, held: after.held });
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
  const bodyArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
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
    }
    else bodyArgs.push(argument);
  }
  const reach = bell ? 'bell' : undefined;
  if (bodyArgs.length !== 1) {
    if (bodyArgs.length === 0 && !process.stdin.isTTY) bodyArgs.push('-');
    else fail("express requires a body argument (a quoted string or '-' with piped stdin)");
  }
  return { activity: bodyArgs[0], force, noWait, noMention, mentions, reach, reply };
}

export const expressCommand: CommandSpec<ActivityIntent> = {
  parse: parseActivity,
  async execute(intent, context) {
    const rawInput = await resolveBody(intent.activity);
    await executeExpression((control) => Square.at(squareInput(context), control), requireSquarePath(context), context.name, rawInput, {
      force: intent.force, noWait: intent.noWait, noMention: intent.noMention,
      mentions: intent.mentions, reach: intent.reach, reply: intent.reply,
    });
  },
  present: () => {},
};

function parseListener(argv: string[], context: CommandContext, targetRequired: boolean): ListenerIntent {
  if (targetRequired ? argv.length !== 1 : argv.length !== 0) usage(context.command);
  return targetRequired ? { target: argv[0] } : {};
}

function listenerCommand(verb: 'listen' | 'ignore' | 'unlisten'): CommandSpec<ListenerIntent, string> {
  return {
    parse(argv, context) { return parseListener(argv, context, true); },
    async execute(intent, context) {
      const data = await withSquare(context, async (square) => (await square.participant(context.name))[verb](intent.target!, { observe: true }));
      const projection = data.observation!;
      const actor = participantIdentity(projection.participant);
      const target = participantIdentity(projection.target);
      const action = data.activity !== null
        ? verb === 'listen' ? `${actor} turns an ear toward ${target}`
          : verb === 'ignore' ? `${actor} turns away from ${target}`
            : `${actor} stops listening to ${target}`
        : verb === 'listen' ? `${actor} already turns an ear toward ${target}`
          : verb === 'ignore' ? `${actor} is not turned toward ${target}`
            : `${actor} is not listening to ${target}`;
      return withPathOutput(projection.location, `${data.activity === null ? '○' : '·'} ${action}`, {
        participantCount: projection.standingCount, held: projection.held,
      });
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
    const data = await withSquare(context, async (square) => (await square.participant(context.name)).listening({ observe: true }));
    const projection = data.observation!;
    const body = data.listening.length === 0
      ? `○ ${participantIdentity(projection.participant!)} is not turned toward anyone`
      : ['listening', ...data.listening.map((target) => `  · ${participantIdentity(target)}`)].join('\n');
    return withPathOutput(projection.location, body, { participantCount: projection.standingCount, held: projection.held });
  },
  present: (result) => process.stdout.write(result),
};

export const doneCommand: CommandSpec<BodyIntent, string> = {
  parse(argv, context) {
    if (argv.length > 1) usage(context.command);
    return { body: argv[0] };
  },
  async execute(intent, context) {
    const body = intent.body === '-' || ((intent.body === undefined || intent.body === '') && !process.stdin.isTTY)
      ? await readStdin() : intent.body;
    const data = await withSquare(context, async (square) => (await square.participant(context.name)).done(body, { observe: true }));
    const projection = data.observation!;
    return withPathOutput(projection.location, `○ you stepped out — your footsteps fade · ${data.activity.id}`, {
      participantCount: projection.standingCount, held: projection.held,
    });
  },
  present: (result) => process.stdout.write(result),
};

export const holdCommand: CommandSpec<BodyIntent, string> = {
  parse(argv, context) {
    if (argv.length > 1) usage(context.command);
    return { body: argv[0] };
  },
  async execute(intent, context) {
    const body = (await resolveBody(intent.body ?? '')).replace(/\r\n/g, '\n').trim();
    const result = await withSquare(context, async (square) => (await square.participant(context.name)).hold(body, { observe: true }));
    const projection = result.observation!;
    return withPathOutput(projection.location,
      `· ${renderRoomChangeText(projection.activity as RoomChangeAct)} · ${formatActivityId(projection.activity.index)} · just now`,
      { participantCount: projection.standingCount, held: projection.held });
  },
  present: (result) => process.stdout.write(result),
};

export const resumeCommand: CommandSpec<Record<string, never>, string> = {
  parse(argv, context) {
    if (argv.length !== 0) usage(context.command);
    return {};
  },
  async execute(_intent, context) {
    const result = await withSquare(context, async (square) => (await square.participant(context.name)).resume({ observe: true }));
    const projection = result.observation!;
    return withPathOutput(projection.location,
      `✓ ${renderRoomChangeText(projection.activity as RoomChangeAct)} · ${formatActivityId(projection.activity.index)} · just now`,
      { participantCount: projection.standingCount, held: projection.held });
  },
  present: (result) => process.stdout.write(result),
};
