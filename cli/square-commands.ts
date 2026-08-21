import { cmdActivity } from '../activity.js';
import { loadSquare } from '../artifact.js';
import { cmdCompact } from '../compact.js';
import {
  type BuildOptions,
  type HardCap,
  type Reach,
  formatHardCap,
} from '../model.js';
import {
  participantCommandPrefix,
  quoteShell,
  renderEventCli,
  renderPublicTail,
  withPathOutput,
} from '../presentation.js';
import {
  hasAutomaticDeliveryIdentity,
  localParticipantOwner,
  recordLocalDone,
  recordLocalJoin,
} from '../registry.js';
import { sweepPendingNotifications } from '../notifications.js';
import { inSquareCount, nowMs } from '../runtime.js';
import { createSquare, openFileApplication } from '../square-file-adapter.js';
import { formatActivityId, parseActivityId } from '../square-core.js';

import {
  type CommandContext,
  type CommandSpec,
  fail,
  parseHardCap,
  parsePositiveInteger,
  readPipedBodyFallback,
  readStdinSync,
  requireParticipant,
  requireValue,
  resolveBody,
  usage,
} from './context.js';

interface BuildIntent {
  options: BuildOptions & { hardCap: HardCap };
  snippet: string;
}

interface JoinIntent {
  name: string;
  lastN: number | null;
  kick: boolean;
}

interface ActivityIntent {
  name: string;
  activity: string;
  force: boolean;
  noWait: boolean;
  reach?: Reach;
  reply?: number;
}

interface BodyIntent {
  name: string;
  body?: string;
}

function parseBuild(argv: string[]): BuildIntent {
  const options: BuildOptions & { hardCap: HardCap } = { force: false, hardCap: null };
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
  if (options.throttlePerMinute !== undefined && options.throttlePerMinute <= 0) {
    fail('Invalid build option: --throttle must be a positive integer.');
  }
  const snippet = readStdinSync();
  if (snippet.trim() === '') fail('Missing Markdown body snippet on stdin.');
  return { options, snippet };
}

export const buildCommand: CommandSpec<BuildIntent, string> = {
  parse: (argv) => parseBuild(argv),
  async execute(intent, context) {
    await createSquare(context.squarePath, intent.options, intent.snippet);
    const cap = intent.options.hardCap === null ? 'unlimited' : formatHardCap(intent.options.hardCap);
    const throttle = intent.options.throttlePerMinute === undefined ? [] : [`  · throttle ${intent.options.throttlePerMinute}/min`];
    return withPathOutput(
      context.squarePath,
      ['✓ built', `  · cap ${cap}`, ...throttle, '  · participants (none seeded — first join adds names)'].join('\n'),
      { participantCount: 0 }
    );
  },
  present: (result) => process.stdout.write(result),
};

function parseJoin(argv: string[], context: CommandContext): JoinIntent {
  let lastN: number | null = 10;
  let kick = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--last') {
      lastN = parsePositiveInteger(requireValue(argv, index, argv[index]), argv[index]);
      index += 1;
    } else if (argv[index] === '--all') {
      lastN = null;
    } else if (argv[index] === '--kick') {
      kick = true;
    } else {
      usage(context.command);
    }
  }
  return { name: requireParticipant(context.name), lastN, kick };
}

export const joinCommand: CommandSpec<JoinIntent, string> = {
  parse: parseJoin,
  async execute(intent, context) {
    const application = await openFileApplication(context.squarePath, { clock: nowMs });
    try {
      const joined = await application.join(intent.name);
      const joinedName = joined.name;
      const isRejoin = joined.activity === null;
      const reconnect = isRejoin
        && localParticipantOwner(context.squarePath, joinedName) !== undefined;
      if (isRejoin && !intent.kick && !reconnect) {
        fail(
          [
            `✕ ${joinedName} shoos you out of the square`,
            `  · a same-named participant stands here — the name is taken`,
            `  · --kick banishes her and the name becomes yours`,
            `» ${participantCommandPrefix(context.squarePath, joinedName)} join --kick`,
          ].join('\n')
        );
      }
      const after = loadSquare(context.squarePath);
      const preamble = after.preamble.at(-1) === '---' ? after.preamble.slice(0, -1) : after.preamble;
      recordLocalJoin(joinedName, context.squarePath);
      await sweepPendingNotifications(context.squarePath);
      const activities = renderPublicTail(after.acts, intent.lastN, nowMs(), joinedName);
      const contextText = preamble.join('\n').trim();
      const fallback = hasAutomaticDeliveryIdentity()
        ? []
        : ['', `» ${participantCommandPrefix(context.squarePath, joinedName)} catch --idle 30m`, '  no session delivery detected — keep this catch open for new activity'];
      const scene = after.warmup.join('\n').trim();
      const entryLine = !isRejoin
        ? '● You stepped into the square'
        : reconnect && !intent.kick
          ? '● you are already in the square'
          : `✓ you banished the original ${joinedName} — the name is yours`;
      const output = [
        entryLine,
        ...(reconnect || scene === '' ? [] : ['', scene]),
        ...(isRejoin || contextText === '' ? [] : ['', 'context', contextText]),
        ...(isRejoin || activities === '' ? [] : ['', 'recent activity', activities]),
        ...fallback,
      ].join('\n');
      return withPathOutput(context.squarePath, output, { participantCount: inSquareCount(after) });
    } finally {
      await application.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

function parseActivity(argv: string[], context: CommandContext): ActivityIntent {
  let force = false;
  let noWait = false;
  let bell = false;
  let reply: number | undefined;
  const bodyArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '-f' || argument === '--force') force = true;
    else if (argument === '--no-wait') noWait = true;
    else if (argument === '--beside') fail('✕ express does not know --beside\n» square express --help');
    else if (argument === '--bell') bell = true;
    else if (argument === '--reply') {
      const replyIndex = parseActivityId(requireValue(argv, index, argument));
      if (replyIndex === undefined) fail('Invalid --reply: expected an activity id like act/12');
      reply = replyIndex;
      index += 1;
    }
    else bodyArgs.push(argument);
  }
  const reach = bell ? 'bell' : undefined;
  if (bodyArgs.length !== 1) {
    if (bodyArgs.length === 0) {
      const piped = readPipedBodyFallback();
      if (piped !== undefined) return { name: requireParticipant(context.name), activity: piped, force, noWait, reach, reply };
    }
    fail("express requires a body argument (a quoted string or '-' with piped stdin)");
  }
  return { name: requireParticipant(context.name), activity: bodyArgs[0], force, noWait, reach, reply };
}

export const expressCommand: CommandSpec<ActivityIntent> = {
  parse: parseActivity,
  async execute(intent, context) {
    await sweepPendingNotifications(context.squarePath);
    const reachArg = intent.reach === 'bell' ? ' --bell' : '';
    await cmdActivity(context.squarePath, intent.name, intent.activity, resolveBody, {
      force: intent.force,
      noWait: intent.noWait,
      reach: intent.reach,
      reply: intent.reply,
      forceCommand: `${participantCommandPrefix(context.squarePath, intent.name)} express --force${reachArg}${intent.reply === undefined ? '' : ` --reply ${formatActivityId(intent.reply)}`} -`,
    });
  },
  present: () => {},
};

function parseDone(argv: string[], context: CommandContext): BodyIntent {
  if (argv.length > 1) usage(context.command);
  return { name: requireParticipant(context.name), body: argv.length === 1 ? argv[0] : readPipedBodyFallback() };
}

export const doneCommand: CommandSpec<BodyIntent, string> = {
  parse: parseDone,
  async execute(intent, context) {
    const body = resolveBody(intent.body ?? '').replace(/\r\n/g, '\n').trim();
    const application = await openFileApplication(context.squarePath, { clock: nowMs });
    const result = await application.done(intent.name, body).finally(() => application.close());
    const name = result.activity.actor;
    recordLocalDone(name, context.squarePath);
    return withPathOutput(context.squarePath, `○ ${name} steps out of the square — done · just now`, { participantCount: inSquareCount(loadSquare(context.squarePath)) });
  },
  present: (result) => process.stdout.write(result),
};

function parseHold(argv: string[], context: CommandContext): BodyIntent {
  if (argv.length > 1) usage(context.command);
  return { name: requireParticipant(context.name), body: argv[0] };
}

export const holdCommand: CommandSpec<BodyIntent, string> = {
  parse: parseHold,
  async execute(intent, context) {
    const application = await openFileApplication(context.squarePath, { clock: nowMs });
    const result = await application.hold(intent.name, resolveBody(intent.body ?? '').replace(/\r\n/g, '\n').trim())
      .finally(() => application.close());
    const doc = loadSquare(context.squarePath);
    const index = parseActivityId(result.activity.id)!;
    return withPathOutput(context.squarePath, renderEventCli(doc.acts.find((activity) => activity.index === index)!), { participantCount: inSquareCount(doc), held: true });
  },
  present: (result) => process.stdout.write(result),
};

export const resumeCommand: CommandSpec<{ name: string }, string> = {
  parse(argv, context) {
    if (argv.length !== 0) usage(context.command);
    return { name: requireParticipant(context.name) };
  },
  async execute(intent, context) {
    const application = await openFileApplication(context.squarePath, { clock: nowMs });
    const result = await application.resume(intent.name).finally(() => application.close());
    const doc = loadSquare(context.squarePath);
    const index = parseActivityId(result.activity.id)!;
    return withPathOutput(context.squarePath, renderEventCli(doc.acts.find((activity) => activity.index === index)!), { participantCount: inSquareCount(doc) });
  },
  present: (result) => process.stdout.write(result),
};

export const compactCommand: CommandSpec<{ keep: number }> = {
  parse(argv, context) {
    let keep = 50;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] !== '--keep') usage(context.command);
      keep = parsePositiveInteger(requireValue(argv, index, argv[index]), argv[index]);
      index += 1;
    }
    return { keep };
  },
  async execute(intent, context) {
    await cmdCompact(context.squarePath, intent);
  },
  present: () => {},
};
