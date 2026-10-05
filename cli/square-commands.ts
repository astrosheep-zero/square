import { cmdActivity } from '../activity.js';
import { scanMentionCandidates } from '../mention-parse.js';
import { validateDoneBody } from '../decisions.js';
import {
  type BuildOptions,
  type HardCap,
  type Reach,
  type RoomChangeAct,
  formatHardCap,
} from '../model.js';
import {
  formatRefusal,
  participantCommandPrefix,
  participantIdentity,
  takeoverRecoveryLines,
  quoteShell,
  renderRoomChangeText,
  renderAmbientEvent,
  withPathOutput,
} from '../presentation.js';
import {
  claimSessionParticipant,
  hostLedgerForEnv,
  hasAutomaticDeliveryIdentity,
  localSessionIdentities,
  lookupParticipant,
  readParticipantOwner,
  recordSessionDone,
} from '../registry.js';
import { sessionIdsFromEnvironment } from '../square-projections.js';
import { actId, inSquareCount, nowMs } from '../runtime.js';
import { createSquare, openSquare } from '../square-file-adapter.js';
import { closeOpenSquare } from '../open-square.js';
import { Square } from '../square-wiring.js';
import { createSquareApplication } from '../square-application.js';
import { entryPresentation, eventPresentation } from '../views.js';
import { createDefaultWakeTransport } from '../notifications.js';
import { style } from '../tty-style.js';
import type { Participant } from '../square-facade.js';

import {
  type CommandContext,
  type CommandSpec,
  fail,
  parseBoundedLimit,
  parseHardCap,
  parsePositiveInteger,
  readStdin,
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
  lastN: number;
  kick: boolean;
}

interface ActivityIntent {
  name: string;
  activity: string;
  force: boolean;
  noWait: boolean;
  noMention: boolean;
  mentions: string[];
  reach?: Reach;
  reply?: string;
}

interface BodyIntent {
  name: string;
  body?: string;
}

interface ListenerIntent {
  name: string;
  target?: string;
}

const JOIN_DEFAULT_LAST = 10;
const JOIN_MAX_LAST = 100;

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
  return { options, snippet: '' };
}

export const buildCommand: CommandSpec<BuildIntent, string> = {
  parse: (argv) => parseBuild(argv),
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const snippet = await readStdin();
    if (snippet.trim() === '') fail('Missing Markdown body snippet on stdin.');
    await createSquare(squarePath, intent.options, snippet);
    const cap = intent.options.hardCap === null ? 'unlimited' : formatHardCap(intent.options.hardCap);
    const throttle = intent.options.throttlePerMinute === undefined ? [] : [`  · throttle ${intent.options.throttlePerMinute}/min`];
    return withPathOutput(
      squarePath,
      ['✓ the square is open', `  · cap ${cap}`, ...throttle, '  · nobody here yet — the first join steps in'].join('\n'),
      { participantCount: 0 }
    );
  },
  present: (result) => process.stdout.write(result),
};

function parseJoin(argv: string[], context: CommandContext): JoinIntent {
  const name = requireParticipant(context.name);
  const squarePath = requireSquarePath(context);
  let lastN = JOIN_DEFAULT_LAST;
  let kick = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--last') {
      lastN = parseBoundedLimit(
        argv[index + 1],
        '--last',
        JOIN_MAX_LAST,
        `${participantCommandPrefix(squarePath, name)} join --last ${JOIN_MAX_LAST}`,
      );
      index += 1;
    } else if (argv[index] === '--kick') {
      kick = true;
    } else {
      usage(context.command);
    }
  }
  return { name, lastN, kick };
}

export const joinCommand: CommandSpec<JoinIntent, string> = {
  parse: parseJoin,
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const hostLedger = hostLedgerForEnv(context.env);
    const beforeSquare = await openSquare(squarePath, { clock: nowMs, env: context.env, hostLedger });
    const before = await entryPresentation(beforeSquare, intent.name, intent.lastN);
    await closeOpenSquare(beforeSquare);
    const application = createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, participant: intent.name, clock: nowMs, hostLedger, wakeTransport: await createDefaultWakeTransport(hostLedger, nowMs) });
    let joinedName: string;
    let joinKind: 'joined' | 'reconnected' | 'taken-over';
    try {
      const result = await application.join({ takeover: intent.kick });
      joinedName = result.participant;
      joinKind = result.kind;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'already_joined') {
        process.stderr.write(formatRefusal(squarePath, [
          `✕ ${participantIdentity(intent.name)} shoos you out of the square`,
          '  · a same-named participant stands here — the name is taken',
          ...takeoverRecoveryLines(squarePath, intent.name),
        ], { participantCount: before.participantCount }));
        process.exit(2);
      }
      throw error;
    }
      const afterSquare = await openSquare(squarePath, { clock: nowMs, env: context.env, hostLedger })
      const after = await entryPresentation(afterSquare, joinedName, intent.lastN);
      await closeOpenSquare(afterSquare);
      const activities = after.recentActivities.map((event) => renderAmbientEvent(event, joinedName, {
        now: nowMs(),
        preview: intent.lastN === null ? undefined : 200,
        actNumber: event.kind === 'say' ? after.sayNumbers[event.index] : undefined,
        squareState: after.state,
      })).filter(Boolean).join('\n\n');
      const contextText = after.joinContext;
      const fallback = hasAutomaticDeliveryIdentity()
        ? []
        : ['', `${participantCommandPrefix(squarePath, joinedName)} catch --idle 30m`, '  the square has no way to call you — keep this catch open and stay within earshot'];
      const scene = after.scene;
      const entryLine = joinKind === 'joined'
        ? '● you stepped into the square'
        : joinKind === 'reconnected'
          ? '● you are already in the square'
          : `✓ you banished the original ${participantIdentity(joinedName)} — the name is yours`;
      const isRejoin = joinKind !== 'joined';
      const reconnect = joinKind === 'reconnected';
      const output = [
        entryLine,
        '',
        "· carved into the fountain's edge: every word here lands on a real ear — speak when someone needs it.",
        ...(reconnect || scene === '' ? [] : ['', scene]),
        ...(isRejoin || contextText === '' ? [] : ['', style('dim', 'context'), contextText]),
        ...(isRejoin || activities === '' ? [] : ['', style('dim', 'recent activity'), activities]),
        ...fallback,
      ].join('\n');
      return withPathOutput(squarePath, output, { participantCount: after.participantCount });
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
    }
    else if (argument === '--reply') {
      reply = requireValue(argv, index, argument);
      index += 1;
    }
    else bodyArgs.push(argument);
  }
  const reach = bell ? 'bell' : undefined;
  if (bell && (noMention || mentions.length > 0)) fail('✕ --bell cannot be combined with --mention or --no-mention\nsquare express --help');
  if (noMention && mentions.length > 0) fail('✕ --no-mention cannot be combined with --mention\nsquare express --help');
  if (bodyArgs.length !== 1) {
    if (bodyArgs.length === 0) {
      if (!process.stdin.isTTY) return { name: requireParticipant(context.name), activity: '-', force, noWait, noMention, mentions, reach, reply };
    }
    fail("express requires a body argument (a quoted string or '-' with piped stdin)");
  }
  return { name: requireParticipant(context.name), activity: bodyArgs[0], force, noWait, noMention, mentions, reach, reply };
}

export const expressCommand: CommandSpec<ActivityIntent> = {
  parse: parseActivity,
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const body = await resolveBody(intent.activity);
    if (intent.reach === undefined && !intent.noMention && intent.mentions.length === 0 && scanMentionCandidates(body).length === 0) {
      fail('✕ express needs --mention <name>, --no-mention, --bell, or an @name in the body\nsquare express --help');
    }
    await cmdActivity(squarePath, intent.name, body, (value) => value, {
      force: intent.force,
      noWait: intent.noWait,
      noMention: intent.noMention,
      mentions: intent.mentions,
      reach: intent.reach,
      reply: intent.reply,
      cwd: context.cwd,
      env: context.env,
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
    try {
      const result = await createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, participant: intent.name, clock: nowMs }).listen(intent.target!);
      const participantCount = (await square.snapshot()).participants.filter((item) => item.state === 'joined').length;
      return listenerPresentation(squarePath, intent.name, intent.target!, 'listen', result.activity, participantCount);
    } finally {
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
    try {
      const result = await createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, participant: intent.name, clock: nowMs }).ignore(intent.target!);
      const participantCount = (await square.snapshot()).participants.filter((item) => item.state === 'joined').length;
      return listenerPresentation(squarePath, intent.name, intent.target!, 'ignore', result.activity, participantCount);
    } finally {
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
    try {
      const participant = { name: intent.name };
      const targets = await createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, participant: intent.name, clock: nowMs }).listening();
      const participantCount = (await square.snapshot()).participants.filter((item) => item.state === 'joined').length;
      const body = targets.length === 0
        ? `○ ${participantIdentity(participant.name)} is not turned toward anyone`
        : ['listening', ...targets.map((target) => `  · ${participantIdentity(target)}`)].join('\n');
      return withPathOutput(squarePath, body, { participantCount });
    } finally {
      await square.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

function validateDoneInput(body: string | undefined): void {
  try { validateDoneBody(body); }
  catch (error) { fail(`${error instanceof Error ? error.message : String(error)}\nsquare done --help`); }
}

function parseDone(argv: string[], context: CommandContext): BodyIntent {
  if (argv.length > 1) usage(context.command);
  if (argv[0] !== '-') validateDoneInput(argv[0]);
  return { name: requireParticipant(context.name), body: argv.length === 1 ? argv[0] : undefined };
}

export const doneCommand: CommandSpec<BodyIntent, string> = {
  parse: parseDone,
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const body = intent.body === '-' || !process.stdin.isTTY ? await readStdin() : '';
    validateDoneInput(body);
    const application = createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, clock: nowMs, participant: intent.name });
    const result = await application.done(body);
    const name = result.activity.actor;
    const presentation = await openSquare(squarePath, { clock: nowMs, env: context.env, hostLedger: hostLedgerForEnv(context.env) });
    const participantCount = (await entryPresentation(presentation, name).finally(() => closeOpenSquare(presentation))).participantCount;
    return withPathOutput(squarePath, `○ ${participantIdentity(name)} steps out of the square — done · ${result.activity.id} · just now`, { participantCount });
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
    const application = createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, clock: nowMs, participant: intent.name });
    const result = await application.hold((await resolveBody(intent.body ?? '')).replace(/\r\n/g, '\n').trim());
      const presentationSquare = await openSquare(squarePath, { clock: nowMs, env: context.env, hostLedger: hostLedgerForEnv(context.env) });
      const presentation = await eventPresentation(presentationSquare, result.activity.id);
      await closeOpenSquare(presentationSquare);
      return withPathOutput(squarePath, `· ${renderRoomChangeText(presentation.activity as RoomChangeAct)} · ${actId(presentation.activity.index)} · just now`, { participantCount: presentation.participantCount, held: true });
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
    const application = createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, clock: nowMs, participant: intent.name });
    const result = await application.resume();
      const presentationSquare = await openSquare(squarePath, { clock: nowMs, env: context.env, hostLedger: hostLedgerForEnv(context.env) });
      const presentation = await eventPresentation(presentationSquare, result.activity.id);
      await closeOpenSquare(presentationSquare);
      return withPathOutput(squarePath, `✓ ${renderRoomChangeText(presentation.activity as RoomChangeAct)} · ${actId(presentation.activity.index)} · just now`, { participantCount: presentation.participantCount });
  },
  present: (result) => process.stdout.write(result),
};
