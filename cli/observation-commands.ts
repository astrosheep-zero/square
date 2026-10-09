import { runClaudeMod } from '../claude-mod.js';
import { runCodexHookAsync } from '../codex-hook.js';
import { sessionInbox } from '../inbox.js';
import { sweepPendingNotifications } from '../notifications.js';
import { cmdListSquares } from '../list.js';
import { nameKey, parseActivityId, type ActivitiesOptions, type StoredAct, type WatchOptions, sameName } from '../model.js';
import {
  commandPrefix,
  participantIdentity,
  renderGrepActivitiesView,
  renderEventCli,
  renderAmbientEventFacts,
  renderPresenceAnchor,
  truncateChars,
  withPathOutput,
  quoteShell,
} from '../presentation.js';
import { actId, nowMs } from '../runtime.js';
import { style } from '../tty-style.js';
import { cmdStream, cmdStreamNdjson, type StreamStart } from '../stream.js';
import { formatRelativeTime, formatTimestamp, parseTimeOrRelative } from '../time.js';
import { cmdWatch } from '../watch.js';
import { openSquare } from '../square-file-adapter.js';
import { closeOpenSquare } from '../open-square.js';
import { createSquareApplication } from '../square-application.js';
import { historyPresentation, participantsPresentation, statusPresentation, type HistoryPresentation } from '../views.js';
import { hostLedgerForEnv } from '../registry.js';

import {
  type CommandContext,
  type CommandSpec,
  fail,
  parseBoundedLimit,
  parseDurationMs,
  parseNameList,
  parseNonNegativeInteger,
  readStdin,
  requireParticipant,
  requireSquarePath,
  requireValue,
  usage,
} from './context.js';
import { CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT } from '../catch-decisions.js';

const STATUS_PARTICIPANT_PREVIEW_LIMIT = 10;
/** A participant counts as here when their last sign of life sits inside this window. */
const STATUS_HERE_WINDOW_MS = 30 * 60_000;
const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_MAX_LIMIT = 100;
const PARTICIPANTS_DEFAULT_LIMIT = 20;
const PARTICIPANTS_MAX_LIMIT = 100;
const INBOX_DEFAULT_LIMIT = 20;
const INBOX_MAX_LIMIT = 100;
const INBOX_DISPLAY_CHARS = 160;

function inboxDisplay(value: string): string {
  const truncated = truncateChars(value, INBOX_DISPLAY_CHARS - 1);
  return truncated.remaining === 0 ? truncated.text : `${truncated.text}…`;
}

function inboxLimitCommand(sessionId: string, json: boolean): string {
  return `square inbox --for-session ${quoteShell(sessionId)} --limit ${INBOX_MAX_LIMIT}${json ? ' --json' : ''}`;
}

interface HistoryCommandOptions extends ActivitiesOptions {
  noTruncate: boolean;
  continuationArgs: string[];
}

export const listCommand: CommandSpec<string[]> = {
  parse: (argv) => argv,
  async execute(argv, context) {
    await cmdListSquares(argv, () => usage(context.command));
  },
  present: () => {},
};

interface StreamIntent { ndjson: boolean; forName?: string; start: StreamStart; }

export const streamCommand: CommandSpec<StreamIntent> = {
  parse(argv, context) {
    let ndjson = false;
    let forName: string | undefined;
    let last = 10;
    let after: number | undefined;
    let hasLast = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--ndjson') ndjson = true;
      else if (argv[index] === '--for') {
        forName = requireValue(argv, index, argv[index]);
        index += 1;
      } else if (argv[index] === '--last') {
        if (after !== undefined) fail('Invalid stream options: --last and --after cannot be combined.');
        last = parseNonNegativeInteger(requireValue(argv, index, argv[index]), '--last');
        if (last > 100) fail('Invalid --last: maximum is 100.');
        hasLast = true;
        index += 1;
      } else if (argv[index] === '--after') {
        if (hasLast) fail('Invalid stream options: --last and --after cannot be combined.');
        after = parseActRef(requireValue(argv, index, argv[index]), '--after');
        index += 1;
      } else usage(context.command);
    }
    if (!ndjson && argv.length > 0) usage(context.command);
    return { ndjson, forName, start: after === undefined ? { kind: 'tail', last } : { kind: 'after', after } };
  },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    if (intent.ndjson) await cmdStreamNdjson(squarePath, intent.forName, intent.start);
    else await cmdStream(squarePath);
  },
  present: () => {},
};

export const catchCommand: CommandSpec<WatchOptions> = {
  parse(argv, context) {
    const name = requireParticipant(context.name);
    let idleMs: number | undefined;
    let mention: string | undefined;
    let limit: number | undefined;
    let id: WatchOptions['id'];
    let replace = false;
    let now = false;
    const participants: string[] = [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--id') {
        if (id !== undefined) fail('✕ catch accepts one --id\nsquare catch --help');
        const value = requireValue(argv, index, '--id');
        if (parseActivityId(value) === undefined) fail('✕ invalid --id: expected an activity id like act/12\nsquare catch --help');
        id = value as WatchOptions['id'];
        index += 1;
      } else if (argv[index] === '--from') {
        participants.push(...parseNameList(requireValue(argv, index, argv[index]), argv[index]));
        index += 1;
      } else if (argv[index] === '--idle') {
        idleMs = parseDurationMs(requireValue(argv, index, argv[index]), argv[index]);
        index += 1;
      } else if (argv[index] === '--mention') {
        mention = name;
      } else if (argv[index] === '--limit') {
        limit = parseBoundedLimit(argv[index + 1], '--limit', CATCH_MAX_LIMIT, `${commandPrefix(requireSquarePath(context))} catch --now --limit ${CATCH_MAX_LIMIT}`);
        index += 1;
      } else if (argv[index] === '--replace') replace = true;
      else if (argv[index] === '--now') now = true;
      else fail(`✕ catch does not know ${argv[index]}\nsquare catch --help`);
    }
    if (id !== undefined) {
      if (argv.some((flag) => ['--idle', '--from', '--mention', '--limit', '--replace'].includes(flag))) {
        fail('✕ --id cannot be combined with --idle, --from, --mention, --limit or --replace\nsquare catch --help');
      }
      return { id, now: true };
    }
    if (now === (idleMs !== undefined)) fail('catch requires exactly one mode: --now or --idle <duration>.');
    if (replace && now) fail('--replace can only be used with --idle.');
    return {
      ...(participants.length > 0 ? { participants } : {}),
      ...(mention === undefined ? {} : { mention }),
      limit: limit ?? CATCH_DEFAULT_LIMIT,
      ...(idleMs === undefined ? {} : { idleMs }),
      ...(replace ? { replace } : {}),
      ...(now ? { now } : {}),
    };
  },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const caught = await cmdWatch(squarePath, requireParticipant(context.name), intent, { cwd: context.cwd, env: context.env });
    if (caught !== false) await sweepPendingNotifications(squarePath);
  },
  present: () => {},
};

function parseActRef(value: string, flag: string): number {
  const index = parseActivityId(value);
  if (index === undefined) fail(`Invalid ${flag}: expected an activity id like act/12`);
  return index;
}

function parseTimestamp(value: string, flag: string): number {
  const timestamp = parseTimeOrRelative(value, nowMs());
  if (!Number.isFinite(timestamp)) fail(`Invalid ${flag} timestamp: ${value}`);
  return timestamp;
}

function historyContinuationArgs(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--limit' || flag === '--before' || flag === '--after') { index += 1; continue; }
    result.push(flag);
    if (flag === '--from' || flag === '--since' || flag === '--at' || flag === '-B' || flag === '-A' || flag === '-C' || flag === '--mention' || flag === '--grep' || flag === '--fixed' || flag === '--order' || flag === '--format') {
      const value = argv[index + 1];
      if (value !== undefined) { result.push(value); index += 1; }
    }
  }
  return result;
}

function parseHistory(argv: string[], context: CommandContext): HistoryCommandOptions {
  const squarePath = requireSquarePath(context);
  let lastN: number | null = HISTORY_DEFAULT_LIMIT;
  let lastNExplicit = false;
  let after: number | undefined;
  let afterIndex: number | undefined;
  let beforeIndex: number | undefined;
  const atIndexes: number[] = [];
  let beforeContext: number | undefined;
  let afterContext: number | undefined;
  let mention: string | undefined;
  let noTruncate = false;
  let grep: string | undefined;
  let fixed: string | undefined;
  let order: 'asc' | 'desc' | undefined;
  let format: string[] | undefined;
  let json = false;
  const participants: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--limit') {
      lastN = parseBoundedLimit(
        argv[index + 1],
        '--limit',
        HISTORY_MAX_LIMIT,
        `${commandPrefix(squarePath)} history --limit ${HISTORY_MAX_LIMIT}`,
      );
      lastNExplicit = true;
      index += 1;
    } else if (flag === '--from') {
      participants.push(...parseNameList(requireValue(argv, index, flag), flag));
      index += 1;
    } else if (flag === '--since') {
      after = parseTimestamp(requireValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === '--after') {
      afterIndex = parseActRef(requireValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === '--before') {
      beforeIndex = parseActRef(requireValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === '--at') {
      const values = requireValue(argv, index, flag).split(',');
      if (values.some((value) => value === '')) fail(`Invalid ${flag}: expected an activity id like act/12`);
      atIndexes.push(...values.map((value) => parseActRef(value, flag)));
      index += 1;
    } else if (flag === '-B') {
      beforeContext = parseNonNegativeInteger(requireValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === '-A') {
      afterContext = parseNonNegativeInteger(requireValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === '-C') {
      const context = parseNonNegativeInteger(requireValue(argv, index, flag), flag);
      beforeContext = context;
      afterContext = context;
      index += 1;
    } else if (flag === '--no-truncate') noTruncate = true;
    else if (flag === '--mention') {
      mention = requireValue(argv, index, flag);
      index += 1;
    }
    else if (flag === '--grep') {
      grep = requireValue(argv, index, flag);
      index += 1;
    } else if (flag === '--fixed') {
      fixed = requireValue(argv, index, flag);
      index += 1;
    } else if (flag === '--order') {
      const value = requireValue(argv, index, flag);
      if (value !== 'asc' && value !== 'desc') fail('Invalid --order: expected asc or desc.');
      order = value;
      index += 1;
    } else if (flag === '--format') {
      format = requireValue(argv, index, flag).split(',').map((item) => item.trim()).filter(Boolean);
      index += 1;
    } else if (flag === '--json') json = true;
    else fail(`✕ history does not know ${flag}\nsquare history --help`);
  }
  if (grep !== undefined && fixed !== undefined) fail('--grep and --fixed cannot be combined.');
  if (grep === '' || fixed === '') fail('--grep and --fixed require non-empty text.');
  if (beforeIndex !== undefined && afterIndex !== undefined) fail('--before and --after cannot be combined.');
  if (!lastNExplicit && atIndexes.length > 0) lastN = null;
  return {
    lastN,
    participants,
    after,
    afterIndex,
    beforeIndex,
    atIndexes: atIndexes.length === 0 ? undefined : atIndexes,
    beforeContext,
    afterContext,
    mention,
    noTruncate,
    grep,
    fixed,
    order,
    format,
    json,
    continuationArgs: historyContinuationArgs(argv),
  };
}

function historyContinuationCommand(options: HistoryCommandOptions, squarePath: string, direction: '--before' | '--after', index: number): string {
  const args = [...(options.continuationArgs ?? []), direction, actId(index), '--limit', String(options.lastN ?? HISTORY_DEFAULT_LIMIT)];
  return `${commandPrefix(squarePath)} history ${args.map((arg) => arg.startsWith('-') || /^act\/\d+$/.test(arg) || /^\d+$/.test(arg) ? arg : quoteShell(arg)).join(' ')}`;
}

function boundedHistoryCommand(options: HistoryCommandOptions, squarePath: string): string {
  const args = [...(options.continuationArgs ?? []), '--limit', String(HISTORY_MAX_LIMIT)];
  return `${commandPrefix(squarePath)} history ${args.map((arg) => arg.startsWith('-') || /^act\/\d+$/.test(arg) || /^\d+$/.test(arg) ? arg : quoteShell(arg)).join(' ')}`;
}

/** The archive-visible activity model: content plus the lifecycle moves that keep its story honest — a raised hand pairs with its lowering, and a departure pairs with the return. */
function isArchiveActivity(item: StoredAct): boolean {
  return item.kind === 'say' || item.kind === 'done' || item.kind === 'hold' || item.kind === 'resume' || item.kind === 'join';
}

function renderFields(sayNumbers: Readonly<Record<number, number>>, item: StoredAct, fields: string[]): string {
  return fields.map((field) => {
    switch (field) {
      case 'id': return actId(item.index);
      case 'author':
      case 'actor': return item.actor ?? '';
      case 'ts':
      case 'at': return formatTimestamp(item.at);
      case 'kind': return item.kind;
      case 'body': return 'body' in item && typeof item.body === 'string' ? item.body.replace(/\s+/g, ' ').trim() : '';
      case 'number': return item.kind === 'say' ? String(sayNumbers[item.index]) : '';
      case 'reply': return item.kind === 'say' && item.reply !== undefined ? actId(item.reply) : '';
      default: return '';
    }
  }).join('\t');
}

function jsonLine(sayNumbers: Readonly<Record<number, number>>, item: StoredAct): string {
  const act = item;
  return JSON.stringify({
    id: actId(item.index),
    index: item.index,
    kind: act.kind,
    author: act.actor ?? null,
    at: act.at,
    ts: formatTimestamp(act.at),
    body: 'body' in act && typeof act.body === 'string' ? act.body : '',
    number: act.kind === 'say' ? sayNumbers[act.index] : null,
    mentions: act.kind === 'say' ? [...(act.mentions ?? [])] : [],
    reach: act.kind === 'say' ? act.reach ?? null : null,
    reply: act.kind === 'say' && act.reply !== undefined ? actId(act.reply) : null,
  });
}

function renderHistoryProjection(
  projection: HistoryPresentation,
  visible: HistoryPresentation['activities'],
  noTruncate: boolean,
  squarePath: string,
): string {
  const shown = visible.filter(isArchiveActivity);
  const preview = noTruncate || shown.length <= 1 ? undefined : 200;
  const chunks: string[] = [];
  for (const activity of shown) {
    const options = {
      preview,
      actNumber: activity.kind === 'say' ? projection.sayNumbers[activity.index] : undefined,
    };
    const rendered = renderEventCli(activity, options);
    if (rendered !== '') chunks.push(rendered);
    const participants = projection.presenceAnchors[activity.index];
    if (participants !== undefined) chunks.push(renderPresenceAnchor(participants));
  }
  if (chunks.length === 0) return 'latest\n  ○ no public activity in this view';
  if (preview !== undefined && shown.some((activity) => activity.kind === 'say' && activity.body.length > preview)) {
    chunks.push(`${commandPrefix(squarePath)} history --no-truncate`);
  }
  return chunks.join('\n\n');
}

export const historyCommand: CommandSpec<HistoryCommandOptions, string> = {
  parse(argv, context) { return parseHistory(argv, context); },
  async execute(options, context) {
    const squarePath = requireSquarePath(context);
    const square = await openSquare(squarePath, { clock: nowMs, env: context.env, hostLedger: hostLedgerForEnv(context.env) });
    try {
      // Keep the projection chronological; pagination chooses a stable edge,
      // then --order only changes how the selected page is displayed. The
      // plain archive hides `read` bookkeeping, while --at/-C/--since windows
      // render the raw activity stream around their coordinates.
      const projection = await historyPresentation(square, { ...options, order: 'asc' });
      const hideReadActs = options.atIndexes === undefined && options.beforeContext === undefined && options.afterContext === undefined && options.after === undefined;
      let events = hideReadActs ? projection.activities.filter((activity) => activity.kind !== 'read') : [...projection.activities];
      if (options.lastN === null && events.length > HISTORY_MAX_LIMIT) {
        fail(`✕ history is capped at ${HISTORY_MAX_LIMIT} activities\n${boundedHistoryCommand(options, squarePath)}`);
      }
      const searching = options.grep !== undefined || options.fixed !== undefined;
      const totalMatches = searching ? events.length : 0;
      if (options.lastN != null) {
        events = options.afterIndex !== undefined
          ? events.slice(0, options.lastN)
          : events.slice(-options.lastN);
      }
      if (options.order === 'desc') events.reverse();
      if (options.json) return events.map((item) => jsonLine(projection.sayNumbers, item)).join('\n') + (events.length > 0 ? '\n' : '');
      if (options.format !== undefined && options.format.length > 0) {
        return events.map((item) => renderFields(projection.sayNumbers, item, options.format!)).join('\n') + (events.length > 0 ? '\n' : '');
      }
      const pattern = options.grep ?? options.fixed;
      const output = pattern === undefined || pattern === ''
        ? renderHistoryProjection(projection, events, options.noTruncate === true, squarePath)
        : renderGrepActivitiesView(events, totalMatches, options.noTruncate, squarePath, pattern, options.fixed !== undefined, () => 'full');
      const publicEvents = events.filter(isArchiveActivity);
      const allPublic = projection.activities.filter(isArchiveActivity);
      const pageMin = publicEvents.length === 0 ? undefined : Math.min(...publicEvents.map((item) => item.index));
      const pageMax = publicEvents.length === 0 ? undefined : Math.max(...publicEvents.map((item) => item.index));
      const hasMore = options.lastN != null && publicEvents.length > 0 && (
        options.afterIndex !== undefined
          ? allPublic.some((item) => item.index > (pageMax ?? options.afterIndex!))
          : allPublic.some((item) => item.index < (pageMin ?? Infinity))
      );
      const cursorDirection = options.afterIndex !== undefined ? '--after' : '--before';
      const cursorIndex = cursorDirection === '--after' ? Math.max(...publicEvents.map((item) => item.index)) : Math.min(...publicEvents.map((item) => item.index));
      const continuation = hasMore ? `\n\n${historyContinuationCommand(options, squarePath, cursorDirection, cursorIndex)}` : '';
      return withPathOutput(squarePath, output + continuation, { participantCount: projection.participantCount });
    } finally {
      await closeOpenSquare(square);
    }
  },
  present: (result) => process.stdout.write(result),
};

interface ParticipantsCommandOptions { limit: number; }

function participantsLimitCommand(squarePath: string, limit: number): string {
  return `${commandPrefix(squarePath)} participants --limit ${limit}`;
}

function parseParticipants(argv: string[], context: CommandContext): ParticipantsCommandOptions {
  let limit = PARTICIPANTS_DEFAULT_LIMIT;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--limit') usage(context.command);
    limit = parseBoundedLimit(
      argv[index + 1],
      '--limit',
      PARTICIPANTS_MAX_LIMIT,
      participantsLimitCommand(requireSquarePath(context), PARTICIPANTS_MAX_LIMIT),
    );
    index += 1;
  }
  return { limit };
}

export const participantsCommand: CommandSpec<ParticipantsCommandOptions, string> = {
  parse(argv, context) { return parseParticipants(argv, context); },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const application = createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, clock: nowMs });
    {
      const now = nowMs();
      const participants = await application.participants();
      const lines = participants.slice(0, intent.limit).map((participant) => {
        const recent = participant.lastActiveAt !== undefined && now - participant.lastActiveAt <= STATUS_HERE_WINDOW_MS;
        const glyph = participant.state === 'done' ? '○' : participant.presence === 'watching' ? '◎' : participant.activityCount > 0 && recent ? '●' : '○';
        const state = participant.state === 'done' ? 'done' : participant.presence === 'watching' ? 'catching' : participant.state;
        const last = participant.lastActiveAt === undefined ? '—' : formatRelativeTime(participant.lastActiveAt, now);
        return `  ${glyph} ${participant.name}${style('dim', ` · ${state} · ${participant.activityCount} ${participant.activityCount === 1 ? 'activity' : 'activities'} · ${last}`)}`;
      });
      const participantCount = participants.filter(
        (participant) => participant.state === 'active'
      ).length;
      const tail = participants.length <= intent.limit
        ? []
        : [
            style('dim', `  ○ ${lines.length} of ${participants.length} participants shown`),
            ...(participants.length <= PARTICIPANTS_MAX_LIMIT ? [
              `${participantsLimitCommand(squarePath, participants.length)}`,
            ] : []),
          ];
      return withPathOutput(squarePath, ['participants', ...lines, ...tail].join('\n'), {
        participantCount,
      });
    }
  },
  present: (result) => process.stdout.write(result),
};

export const statusCommand: CommandSpec<undefined, string> = {
  parse(argv, context) { if (argv.length > 0) usage(context.command); return undefined; },
  async execute(_intent, context) {
    const squarePath = requireSquarePath(context);
    const application = createSquareApplication({ cwd: context.cwd, env: context.env, squarePath, clock: nowMs });
    {
      const presentation = await application.status();
      const result = presentation.status;
    const active = result.participants.filter((participant) => participant.state === 'active');
    const here = active.filter((participant) =>
      participant.presence === 'watching'
      || (participant.lastActiveAt !== undefined && result.now - participant.lastActiveAt <= STATUS_HERE_WINDOW_MS));
    const lingering = active.length - here.length;
    const orderedHere = [
      ...here.filter((participant) => participant.presence === 'watching'),
      ...here.filter((participant) => participant.presence !== 'watching'),
    ];
    const people: string[] = [];
    if (active.length === 0) {
      people.push('  ○ nobody in the square');
    } else {
      if (orderedHere.length === 0) people.push('  ○ nobody here right now');
      people.push(...orderedHere.slice(0, STATUS_PARTICIPANT_PREVIEW_LIMIT).map((participant) => {
        const glyph = participant.presence === 'watching'
          ? '◎'
          : participant.activityCount > 0 ? '●' : '○';
        const summary = participant.presence === 'watching'
          ? 'catching'
          : participant.activityCount > 0
            ? formatRelativeTime(participant.lastActiveAt ?? result.now, result.now)
            : `quiet · ${participant.lastActiveAt === undefined ? 'just now' : formatRelativeTime(participant.lastActiveAt, result.now)}`;
        const showAttention = context.name === undefined || sameName(participant.name, context.name);
        const attention = !showAttention
          ? ''
          : participant.pendingMentionCount > 0
            ? `${participant.pendingMentionCount} ${participant.pendingMentionCount === 1 ? 'mention' : 'mentions'} waiting`
            : participant.unreadActivityCount > 0
              ? `${participant.unreadActivityCount} change${participant.unreadActivityCount === 1 ? '' : 's'} waiting`
              : 'caught up';
        return `  ${glyph} ${participantIdentity(participant.name)}${style('dim', ` · ${summary}${attention === '' ? '' : ` · ${attention}`}`)}`;
      }));
      const unshown = Math.max(0, orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT) + lingering;
      if (orderedHere.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) {
        people.push(`  ○ … ${orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more here`);
      }
      if (lingering > 0) people.push(`  ○ … ${lingering} lingering`);
      if (unshown > 0) {
        people.push(`${result.participants.length <= PARTICIPANTS_MAX_LIMIT
          ? participantsLimitCommand(squarePath, result.participants.length)
          : `${commandPrefix(squarePath)} participants`}`);
      }
    }
    const cap = result.hardCap === null ? 'unlimited' : `${result.hardCap} each`;
    const holdTime = result.holdAt === undefined ? 'just now' : formatRelativeTime(result.holdAt, result.now);
    const hold = result.holdActive
      ? `· ${result.holdActor === undefined ? 'someone' : participantIdentity(result.holdActor)} raised a hand${result.holdReason ? ` — ${result.holdReason}` : ''}${style('dim', ` · ${holdTime}`)}`
      : undefined;
    const visible = result.latestAct === undefined
      ? { text: '', bodyClipped: false }
      : renderAmbientEventFacts(result.latestAct, context.name ?? '', {
          now: result.now,
          preview: 200,
          actNumber: presentation.latestActNumber,
          squareState: presentation.state,
        });
    const latest = visible.text === ''
      ? [result.latestAct === undefined
        ? '  ○ no public activity yet'
        : '  · the latest words were meant for other ears']
      : [`  ${visible.text.replace(/\n/g, '\n  ')}`];
    // Presence events after the latest public act: otherwise the roster can say someone is
    // here while the latest line shows them leaving, with nothing to reconcile the two.
    const latestIndex = result.latestAct?.index ?? -1;
    const stepsIn = presentation.state.acts.filter((act): act is Extract<StoredAct, { kind: 'join' }> =>
      act.kind === 'join' && act.index > latestIndex);
    for (const act of stepsIn.slice(-3)) {
      const rejoined = presentation.state.acts.some((other) =>
        other.kind === 'done' && other.actor === act.actor && other.index < act.index);
      latest.push(style('dim', `  → ${participantIdentity(act.actor)} ${rejoined ? 'stepped back in' : 'stepped in'} · ${formatRelativeTime(act.at, result.now)}`));
    }
    if (stepsIn.length > 3) latest.push(style('dim', `  → … ${stepsIn.length - 3} more stepped in`));
    if (visible.bodyClipped && result.latestAct !== undefined) {
      latest.push(`${commandPrefix(squarePath)} history --at ${actId(result.latestAct)} -C 2 --no-truncate`);
    }
    const counts = [
      `${here.length} here`,
      ...(lingering > 0 ? [`${lingering} lingering`] : []),
      `${result.doneCount} done`,
      `cap ${cap}`,
      `throttle ${result.throttlePerMinute === undefined ? 'none' : `${result.throttlePerMinute}/min`}`,
    ].join(' · ');
    const output = [
      style('dim', counts),
      ...(hold === undefined ? [] : ['', hold]), '', style('dim', 'around the square'), ...people, '', style('dim', 'latest'), ...latest,
    ].join('\n');
    return withPathOutput(squarePath, output, { participantCount: result.activeCount, held: result.holdActive });
    }
  },
  present: (result) => process.stdout.write(result),
};

interface InboxIntent { sessionId: string; json: boolean; limit: number; }
export const inboxCommand: CommandSpec<InboxIntent, string> = {
  parse(argv, context) {
    let sessionId: string | undefined;
    let json = false;
    let limitValue: string | undefined;
    let hasLimit = false;
    let duplicateLimit = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--for-session') { sessionId = requireValue(argv, index, argv[index]); index += 1; }
      else if (argv[index] === '--json') json = true;
      else if (argv[index] === '--limit') {
        if (hasLimit) duplicateLimit = true;
        hasLimit = true;
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith('--')) { limitValue = value; index += 1; }
      }
      else usage(context.command);
    }
    if (!sessionId) fail('inbox requires --for-session <session-id>.');
    const retry = inboxLimitCommand(sessionId, json);
    if (duplicateLimit) fail(`✕ inbox accepts one --limit\n${retry}`);
    const limit = hasLimit
      ? parseBoundedLimit(limitValue, '--limit', INBOX_MAX_LIMIT, retry)
      : INBOX_DEFAULT_LIMIT;
    return { sessionId, json, limit };
  },
  async execute(intent) {
    const inbox = await sessionInbox(intent.sessionId);
    const ordered = [...inbox].sort((left, right) => {
      if (left.squarePath < right.squarePath) return -1;
      if (left.squarePath > right.squarePath) return 1;
      const leftName = nameKey(left.name);
      const rightName = nameKey(right.name);
      if (leftName < rightName) return -1;
      if (leftName > rightName) return 1;
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    });
    const rows = ordered.slice(0, intent.limit).map((membership) => ({
      namePreview: inboxDisplay(membership.name),
      squarePathPreview: inboxDisplay(membership.squarePath),
      pending: membership.notifications.length,
    }));
    if (intent.json) return `${JSON.stringify({ rows, total: ordered.length })}\n`;
    return [
      ...rows.map((row) => `${row.namePreview}\t${row.squarePathPreview}\t${row.pending}\n`),
      ...(rows.length < ordered.length ? [`${rows.length} of ${ordered.length} memberships shown\n`] : []),
    ].join('');
  },
  present: (result) => process.stdout.write(result),
};

function hookCommand(runHook: (input: string) => string | Promise<string>): CommandSpec<undefined, string> {
  return {
    parse(argv, context) { if (argv.length > 0) usage(context.command); return undefined; },
    execute: async () => runHook(await readStdin()),
    present: (result) => process.stdout.write(result),
  };
}

export const claudeModCommand = hookCommand(runClaudeMod);
export const codexHookCommand = hookCommand(runCodexHookAsync);
