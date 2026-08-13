import { cmdActivity } from '../activity.js';
import { loadSquare } from '../artifact.js';
import { cmdCompact } from '../compact.js';
import { type DecideJoinResult } from '../decisions.js';
import {
  type BuildOptions,
  type HardCap,
  type Reach,
  SquareError,
  formatHardCap,
  validateName,
} from '../model.js';
import {
  participantCommandPrefix,
  quoteShell,
  renderEventCli,
  renderPublicTail,
  withPathOutput,
} from '../presentation.js';
import { hasAutomaticDeliveryIdentity, localParticipantOwner, recordLocalDone, recordLocalJoin } from '../registry.js';
import { sweepPendingNotifications } from '../notifications.js';
import { inSquareCount, isCurrentlyJoined, nowMs, resolveRosterName } from '../runtime.js';
import { createSquare, execute } from '../square-application.js';

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
    validateName(intent.name);
    try {
      const committed = await execute<DecideJoinResult>(context.squarePath, { type: 'join', name: intent.name, now: nowMs() });
      const joinedName = committed.result.joinedName;
      const isRejoin = !committed.result.addParticipant;
      const after = loadSquare(context.squarePath);
      const preamble = after.preamble.at(-1) === '---' ? after.preamble.slice(0, -1) : after.preamble;
      recordLocalJoin(joinedName, context.squarePath);
      await sweepPendingNotifications(context.squarePath);
      const activities = renderPublicTail(after.acts, intent.lastN, nowMs(), joinedName);
      const contextText = preamble.join('\n').trim();
      const fallback = hasAutomaticDeliveryIdentity()
        ? []
        : ['', `» ${participantCommandPrefix(context.squarePath, joinedName)} catch --idle 30m`, '  no session delivery detected — keep this catch open for new activity'];
      const output = [
        `● ${joinedName} stepped into the square`,
        ...(isRejoin || contextText === '' ? [] : ['', 'context', contextText]),
        ...(activities === '' ? [] : ['', 'recent activity', activities]),
        ...(isRejoin ? [] : ['', `» ${participantCommandPrefix(context.squarePath, joinedName)} warmup`]),
        ...fallback,
      ].join('\n');
      return withPathOutput(context.squarePath, output, { participantCount: inSquareCount(after) });
    } catch (error) {
      if (!(error instanceof SquareError) || error.code !== 'conflict') throw error;
      const doc = loadSquare(context.squarePath);
      const joinedName = resolveRosterName(doc, intent.name);
      if (joinedName === undefined || !isCurrentlyJoined(doc.acts, joinedName)) throw error;
      const reconnect = localParticipantOwner(context.squarePath, joinedName) !== undefined;
      if (!intent.kick && !reconnect) {
        fail(
          [
            `✕ ${joinedName} shoos you out of the square`,
            `  · a same-named participant stands here — the name is taken`,
            `  · --kick banishes her and the name becomes yours`,
            `» ${participantCommandPrefix(context.squarePath, joinedName)} join --kick`,
          ].join('\n')
        );
      }
      recordLocalJoin(joinedName, context.squarePath);
      await sweepPendingNotifications(context.squarePath);
      const fallback = hasAutomaticDeliveryIdentity()
        ? ''
        : `\n» ${participantCommandPrefix(context.squarePath, joinedName)} catch --idle 30m\n  no session delivery detected — keep this catch open for new activity`;
      const line = reconnect && !intent.kick
        ? `● you are already in the square`
        : `✓ you banished the original ${joinedName} — the name is yours`;
      return withPathOutput(context.squarePath, `${line}${fallback}`, { participantCount: inSquareCount(doc) });
    }
  },
  present: (result) => process.stdout.write(result),
};

function parseActivity(argv: string[], context: CommandContext): ActivityIntent {
  let force = false;
  let noWait = false;
  let beside: string | undefined;
  let bell = false;
  let reply: number | undefined;
  const bodyArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '-f' || argument === '--force') force = true;
    else if (argument === '--no-wait') noWait = true;
    else if (argument === '--beside') {
      beside = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--bell') bell = true;
    else if (argument === '--reply') {
      const value = requireValue(argv, index, argument).trim().match(/^(?:act_)?(\d+)$/i);
      if (!value || !Number.isSafeInteger(Number(value[1]))) fail('Invalid --reply: expected an activity id like act_12 or 12.');
      reply = Number(value[1]);
      index += 1;
    }
    else bodyArgs.push(argument);
  }
  if (bell && beside !== undefined) fail('Invalid express options: --beside and --bell are mutually exclusive.');
  const reach = bell ? 'bell' : beside === undefined ? undefined : { beside };
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
    const reachArg = intent.reach === 'bell' ? ' --bell' : intent.reach === undefined ? '' : ` --beside ${quoteShell(intent.reach.beside)}`;
    await cmdActivity(context.squarePath, intent.name, intent.activity, resolveBody, {
      force: intent.force,
      noWait: intent.noWait,
      reach: intent.reach,
      reply: intent.reply,
      forceCommand: `${participantCommandPrefix(context.squarePath, intent.name)} express --force${reachArg}${intent.reply === undefined ? '' : ` --reply act_${intent.reply}`} -`,
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
    const committed = await execute(context.squarePath, { type: 'done', name: intent.name, body, now: nowMs() });
    const name = committed.acts[0].actor!;
    recordLocalDone(name, context.squarePath);
    return withPathOutput(context.squarePath, `× ${name} steps out of the square — done · just now`, { participantCount: inSquareCount(loadSquare(context.squarePath)) });
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
    const committed = await execute(context.squarePath, { type: 'hold', actor: intent.name, body: resolveBody(intent.body ?? '').replace(/\r\n/g, '\n').trim(), now: nowMs() });
    const doc = loadSquare(context.squarePath);
    return withPathOutput(context.squarePath, renderEventCli(committed.acts[0]), { participantCount: inSquareCount(doc), held: true });
  },
  present: (result) => process.stdout.write(result),
};

export const resumeCommand: CommandSpec<{ name: string }, string> = {
  parse(argv, context) {
    if (argv.length !== 0) usage(context.command);
    return { name: requireParticipant(context.name) };
  },
  async execute(intent, context) {
    const committed = await execute(context.squarePath, { type: 'resume', actor: intent.name, now: nowMs() });
    const doc = loadSquare(context.squarePath);
    return withPathOutput(context.squarePath, renderEventCli(committed.acts[0]), { participantCount: inSquareCount(doc) });
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
