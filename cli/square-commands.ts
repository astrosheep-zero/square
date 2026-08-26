import { cmdActivity } from '../activity.js';
import {
  type BuildOptions,
  type HardCap,
  type Reach,
  formatActivityId,
  formatHardCap,
  parseActivityId,
} from '../model.js';
import {
  participantCommandPrefix,
  participantIdentity,
  quoteShell,
  renderEventCli,
  renderAmbientEvent,
  withPathOutput,
} from '../presentation.js';
import {
  hasAutomaticDeliveryIdentity,
  localParticipantOwner,
  recordLocalDone,
  recordLocalJoin,
} from '../registry.js';
import { sweepPendingNotifications, wakeNotifierForSquare } from '../notifications.js';
import { inSquareCount, nowMs } from '../runtime.js';
import { createSquare, openSquare } from '../square-file-adapter.js';
import { closeOpenSquare } from '../open-square.js';
import { openParticipant, Square } from '../square-wiring.js';
import { entryPresentation, eventPresentation } from '../views.js';

import {
  type CommandContext,
  type CommandSpec,
  fail,
  parseHardCap,
  parsePositiveInteger,
  readPipedBodyFallback,
  readStdinSync,
  requireParticipant,
  requireSquarePath,
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

interface ListenerIntent {
  name: string;
  target?: string;
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
    const squarePath = requireSquarePath(context);
    await createSquare(squarePath, intent.options, intent.snippet);
    const cap = intent.options.hardCap === null ? 'unlimited' : formatHardCap(intent.options.hardCap);
    const throttle = intent.options.throttlePerMinute === undefined ? [] : [`  · throttle ${intent.options.throttlePerMinute}/min`];
    return withPathOutput(
      squarePath,
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
    const squarePath = requireSquarePath(context);
    const beforeSquare = await openSquare(squarePath, { clock: nowMs });
    const before = await entryPresentation(beforeSquare, intent.name, intent.lastN);
    await closeOpenSquare(beforeSquare);
    const square = await Square.at({ path: squarePath, clock: nowMs, notifier: wakeNotifierForSquare(squarePath) });
    try {
      const participant = await square.join(intent.name);
      const joinedName = participant.name;
      const isRejoin = before.joined;
      const reconnect = isRejoin
        && localParticipantOwner(squarePath, joinedName) !== undefined;
      if (isRejoin && !intent.kick && !reconnect) {
        fail(
          [
            `✕ ${participantIdentity(joinedName)} shoos you out of the square`,
            `  · a same-named participant stands here — the name is taken`,
            `  · --kick banishes her and the name becomes yours`,
            `» ${participantCommandPrefix(squarePath, joinedName)} join --kick`,
          ].join('\n')
        );
      }
      const afterSquare = await openSquare(squarePath, { clock: nowMs });
      const after = await entryPresentation(afterSquare, joinedName, intent.lastN);
      await closeOpenSquare(afterSquare);
      recordLocalJoin(joinedName, squarePath);
      await sweepPendingNotifications(squarePath);
      const activities = after.recentActivities.map((event) => renderAmbientEvent(event, joinedName, {
        now: nowMs(),
        preview: intent.lastN === null ? undefined : 200,
        actNumber: event.kind === 'say' ? after.sayNumbers[event.index] : undefined,
        squareState: after.state,
      })).filter(Boolean).join('\n\n');
      const contextText = after.joinContext;
      const fallback = hasAutomaticDeliveryIdentity()
        ? []
        : ['', `» ${participantCommandPrefix(squarePath, joinedName)} catch --idle 30m`, '  no session delivery detected — keep this catch open for new activity'];
      const scene = after.scene;
      const entryLine = !isRejoin
        ? '● You stepped into the square'
        : reconnect && !intent.kick
          ? '● you are already in the square'
          : `✓ you banished the original ${participantIdentity(joinedName)} — the name is yours`;
      const output = [
        entryLine,
        ...(reconnect || scene === '' ? [] : ['', scene]),
        ...(isRejoin || contextText === '' ? [] : ['', 'context', contextText]),
        ...(isRejoin || activities === '' ? [] : ['', 'recent activity', activities]),
        ...fallback,
      ].join('\n');
      return withPathOutput(squarePath, output, { participantCount: after.participantCount });
    } finally {
      await square.close();
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
    const squarePath = requireSquarePath(context);
    await sweepPendingNotifications(squarePath);
    const body = resolveBody(intent.activity);
    const reachArg = intent.reach === 'bell' ? ' --bell' : '';
    await cmdActivity(squarePath, intent.name, body, (value) => value, {
      force: intent.force,
      noWait: intent.noWait,
      reach: intent.reach,
      reply: intent.reply,
      forceCommand: `${participantCommandPrefix(squarePath, intent.name)} express --force${reachArg}${intent.reply === undefined ? '' : ` --reply ${formatActivityId(intent.reply)}`} -`,
    });
  },
  present: () => {},
};

function parseListener(argv: string[], context: CommandContext, targetRequired: boolean): ListenerIntent {
  if (targetRequired ? argv.length !== 1 : argv.length !== 0) usage(context.command);
  return { name: requireParticipant(context.name), ...(targetRequired ? { target: argv[0] } : {}) };
}

function listenerPresentation(
  squarePath: string,
  actor: string,
  target: string,
  verb: 'listen' | 'ignore',
  activity: Awaited<ReturnType<import('../square-facade.js').Participant['listen']>>['activity'],
  participantCount: number,
): string {
  if (activity !== null) {
    const action = verb === 'listen'
      ? `${participantIdentity(actor)} turns an ear toward ${participantIdentity(target)}`
      : `${participantIdentity(actor)} turns away from ${participantIdentity(target)}`;
    return withPathOutput(squarePath, `· ${action}`, { participantCount });
  }
  const action = verb === 'listen'
    ? `${participantIdentity(actor)} already turns an ear toward ${participantIdentity(target)}`
    : `${participantIdentity(actor)} is not turned toward ${participantIdentity(target)}`;
  return withPathOutput(squarePath, `○ ${action}`, { participantCount });
}

export const listenCommand: CommandSpec<ListenerIntent, string> = {
  parse(argv, context) { return parseListener(argv, context, true); },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const square = await Square.at({ path: squarePath, clock: nowMs });
    const facade = await openParticipant({ path: squarePath, clock: nowMs }, intent.name);
    try {
      const participant = facade.participant;
      const result = await participant.listen(intent.target!);
      const participantCount = (await square.snapshot()).participants.filter((item) => item.state === 'joined').length;
      return listenerPresentation(squarePath, participant.name, intent.target!, 'listen', result.activity, participantCount);
    } finally {
      await facade.close();
      await square.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

export const ignoreCommand: CommandSpec<ListenerIntent, string> = {
  parse(argv, context) { return parseListener(argv, context, true); },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const square = await Square.at({ path: squarePath, clock: nowMs });
    const facade = await openParticipant({ path: squarePath, clock: nowMs }, intent.name);
    try {
      const participant = facade.participant;
      const result = await participant.ignore(intent.target!);
      const participantCount = (await square.snapshot()).participants.filter((item) => item.state === 'joined').length;
      return listenerPresentation(squarePath, participant.name, intent.target!, 'ignore', result.activity, participantCount);
    } finally {
      await facade.close();
      await square.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

export const listeningCommand: CommandSpec<ListenerIntent, string> = {
  parse(argv, context) { return parseListener(argv, context, false); },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const square = await Square.at({ path: squarePath, clock: nowMs });
    const facade = await openParticipant({ path: squarePath, clock: nowMs }, intent.name);
    try {
      const participant = facade.participant;
      const targets = await participant.listening();
      const participantCount = (await square.snapshot()).participants.filter((item) => item.state === 'joined').length;
      const body = targets.length === 0
        ? `○ ${participantIdentity(participant.name)} is not turned toward anyone`
        : ['listening', ...targets.map((target) => `  · ${participantIdentity(target)}`)].join('\n');
      return withPathOutput(squarePath, body, { participantCount });
    } finally {
      await facade.close();
      await square.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

function parseDone(argv: string[], context: CommandContext): BodyIntent {
  if (argv.length > 1) usage(context.command);
  return { name: requireParticipant(context.name), body: argv.length === 1 ? argv[0] : readPipedBodyFallback() };
}

export const doneCommand: CommandSpec<BodyIntent, string> = {
  parse: parseDone,
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const body = resolveBody(intent.body ?? '').replace(/\r\n/g, '\n').trim();
    const square = await Square.at({ path: squarePath, clock: nowMs, notifier: wakeNotifierForSquare(squarePath) });
    const participant = await square.join(intent.name);
    const result = await participant.done(body);
    await square.close();
    const name = result.activity.actor;
    recordLocalDone(name, squarePath);
    const presentation = await openSquare(squarePath, { clock: nowMs });
    const participantCount = (await entryPresentation(presentation, name).finally(() => closeOpenSquare(presentation))).participantCount;
    return withPathOutput(squarePath, `○ ${participantIdentity(name)} steps out of the square — done · just now`, { participantCount });
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
    const squarePath = requireSquarePath(context);
    const square = await Square.at({ path: squarePath, clock: nowMs, notifier: wakeNotifierForSquare(squarePath) });
    try {
      const participant = await square.join(intent.name);
      const result = await participant.hold(resolveBody(intent.body ?? '').replace(/\r\n/g, '\n').trim());
      await square.close();
      const presentationSquare = await openSquare(squarePath, { clock: nowMs });
      const presentation = await eventPresentation(presentationSquare, result.activity.id);
      await closeOpenSquare(presentationSquare);
      return withPathOutput(squarePath, renderEventCli(presentation.activity), { participantCount: presentation.participantCount, held: true });
    } finally {
      await square.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

export const resumeCommand: CommandSpec<{ name: string }, string> = {
  parse(argv, context) {
    if (argv.length !== 0) usage(context.command);
    return { name: requireParticipant(context.name) };
  },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const square = await Square.at({ path: squarePath, clock: nowMs, notifier: wakeNotifierForSquare(squarePath) });
    try {
      const participant = await square.join(intent.name);
      const result = await participant.resume();
      await square.close();
      const presentationSquare = await openSquare(squarePath, { clock: nowMs });
      const presentation = await eventPresentation(presentationSquare, result.activity.id);
      await closeOpenSquare(presentationSquare);
      return withPathOutput(squarePath, renderEventCli(presentation.activity), { participantCount: presentation.participantCount });
    } finally {
      await square.close();
    }
  },
  present: (result) => process.stdout.write(result),
};
