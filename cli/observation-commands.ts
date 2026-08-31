import { runClaudeHookAsync } from '../claude-hook.js';
import { runCodexHookAsync } from '../codex-hook.js';
import { sessionInbox } from '../inbox.js';
import { sweepPendingNotifications } from '../notifications.js';
import { cmdListSquares } from '../list.js';
import { parseActivityId, type ActivitiesOptions, type StoredAct, type WatchOptions, sameName } from '../model.js';
import {
  commandPrefix,
  participantIdentity,
  renderGrepActivitiesView,
  renderEventCli,
  renderAmbientEvent,
  renderPresenceAnchor,
  withPathOutput,
  quoteShell,
} from '../presentation.js';
import { actId, nowMs } from '../runtime.js';
import { cmdStream, cmdStreamNdjson } from '../stream.js';
import { formatRelativeTime, formatTimestamp, parseTimeOrRelative } from '../time.js';
import { cmdWatch } from '../watch.js';
import { openSquare } from '../square-file-adapter.js';
import { closeOpenSquare } from '../open-square.js';
import { historyPresentation, participantsPresentation, statusPresentation, type HistoryPresentation } from '../views.js';

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

const STATUS_PARTICIPANT_PREVIEW_LIMIT = 10;
const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_MAX_LIMIT = 100;
const PARTICIPANTS_DEFAULT_LIMIT = 20;
const PARTICIPANTS_MAX_LIMIT = 100;

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

interface StreamIntent { ndjson: boolean; forName?: string; }

export const streamCommand: CommandSpec<StreamIntent> = {
  parse(argv, context) {
    let ndjson = false;
    let forName: string | undefined;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--ndjson') ndjson = true;
      else if (argv[index] === '--for') {
        forName = requireValue(argv, index, argv[index]);
        index += 1;
      } else usage(context.command);
    }
    if (forName !== undefined && !ndjson) usage(context.command);
    return { ndjson, forName };
  },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    if (intent.ndjson) await cmdStreamNdjson(squarePath, intent.forName);
    else await cmdStream(squarePath);
  },
  present: () => {},
};

export const catchCommand: CommandSpec<WatchOptions> = {
  parse(argv, context) {
    const name = requireParticipant(context.name);
    let idleMs: number | undefined;
    let mention: string | undefined;
    let replace = false;
    let now = false;
    const participants: string[] = [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--from') {
        participants.push(...parseNameList(requireValue(argv, index, argv[index]), argv[index]));
        index += 1;
      } else if (argv[index] === '--idle') {
        idleMs = parseDurationMs(requireValue(argv, index, argv[index]), argv[index]);
        index += 1;
      } else if (argv[index] === '--mention') {
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith('--')) {
          mention = value;
          index += 1;
        } else {
          mention = name;
        }
      } else if (argv[index] === '--replace') replace = true;
      else if (argv[index] === '--now') now = true;
      else fail(`✕ catch does not know ${argv[index]}\n» square catch --help`);
    }
    if (now === (idleMs !== undefined)) fail('catch requires exactly one mode: --now or --idle <duration>.');
    if (replace && now) fail('--replace can only be used with --idle.');
    return {
      ...(participants.length > 0 ? { participants } : {}),
      ...(mention === undefined ? {} : { mention }),
      ...(idleMs === undefined ? {} : { idleMs }),
      ...(replace ? { replace } : {}),
      ...(now ? { now } : {}),
    };
  },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const caught = await cmdWatch(squarePath, requireParticipant(context.name), intent);
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
    else fail(`✕ history does not know ${flag}\n» square history --help`);
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
  const shown = visible.filter((activity) => activity.kind === 'say' || activity.kind === 'done');
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
    chunks.push(`» ${commandPrefix(squarePath)} history --no-truncate`);
  }
  return chunks.join('\n\n');
}

export const historyCommand: CommandSpec<HistoryCommandOptions, string> = {
  parse(argv, context) { return parseHistory(argv, context); },
  async execute(options, context) {
    const squarePath = requireSquarePath(context);
    const square = await openSquare(squarePath, { clock: nowMs });
    try {
      // Keep the projection chronological; pagination chooses a stable edge,
      // then --order only changes how the selected page is displayed.
      const projection = await historyPresentation(square, { ...options, order: 'asc' });
      let events = [...projection.activities];
      if (options.lastN === null && events.length > HISTORY_MAX_LIMIT) {
        fail(`✕ history is capped at ${HISTORY_MAX_LIMIT} activities\n» ${boundedHistoryCommand(options, squarePath)}`);
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
      const publicEvents = events.filter((item) => item.kind === 'say' || item.kind === 'done');
      const allPublic = projection.activities.filter((item) => item.kind === 'say' || item.kind === 'done');
      const pageMin = publicEvents.length === 0 ? undefined : Math.min(...publicEvents.map((item) => item.index));
      const pageMax = publicEvents.length === 0 ? undefined : Math.max(...publicEvents.map((item) => item.index));
      const hasMore = options.lastN != null && publicEvents.length > 0 && (
        options.afterIndex !== undefined
          ? allPublic.some((item) => item.index > (pageMax ?? options.afterIndex!))
          : allPublic.some((item) => item.index < (pageMin ?? Infinity))
      );
      const cursorDirection = options.afterIndex !== undefined ? '--after' : '--before';
      const cursorIndex = cursorDirection === '--after' ? Math.max(...publicEvents.map((item) => item.index)) : Math.min(...publicEvents.map((item) => item.index));
      const continuation = hasMore ? `\n\n» ${historyContinuationCommand(options, squarePath, cursorDirection, cursorIndex)}` : '';
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
    const square = await openSquare(squarePath, { clock: nowMs });
    try {
      const now = nowMs();
      const participants = await participantsPresentation(square);
      const lines = participants.slice(0, intent.limit).map((participant) => {
        const glyph = participant.state === 'done' ? '○' : participant.presence === 'watching' ? '◎' : participant.activityCount > 0 ? '●' : '○';
        const state = participant.state === 'done' ? 'done' : participant.presence === 'watching' ? 'catching' : participant.state;
        const last = participant.lastActiveAt === undefined ? '—' : formatRelativeTime(participant.lastActiveAt, now);
        return `  ${glyph} ${participant.name} · ${state} · ${participant.activityCount} ${participant.activityCount === 1 ? 'activity' : 'activities'} · ${last}`;
      });
      const participantCount = participants.filter(
        (participant) => participant.state === 'active'
      ).length;
      const tail = participants.length <= intent.limit
        ? []
        : [
            `  ○ ${lines.length} of ${participants.length} participants shown`,
            ...(participants.length <= PARTICIPANTS_MAX_LIMIT ? [
              `» ${participantsLimitCommand(squarePath, participants.length)}`,
            ] : []),
          ];
      return withPathOutput(squarePath, ['participants', ...lines, ...tail].join('\n'), {
        participantCount,
      });
    } finally {
      await closeOpenSquare(square);
    }
  },
  present: (result) => process.stdout.write(result),
};

export const statusCommand: CommandSpec<undefined, string> = {
  parse(argv, context) { if (argv.length > 0) usage(context.command); return undefined; },
  async execute(_intent, context) {
    const squarePath = requireSquarePath(context);
    const square = await openSquare(squarePath, { clock: nowMs });
    try {
      const presentation = await statusPresentation(square);
      const result = presentation.status;
    const active = result.participants.filter((participant) => participant.state === 'active').sort((a, b) => {
      const aViewer = context.name !== undefined && sameName(a.name, context.name);
      const bViewer = context.name !== undefined && sameName(b.name, context.name);
      if (aViewer !== bViewer) return aViewer ? -1 : 1;
      return (b.lastActiveAt ?? -Infinity) - (a.lastActiveAt ?? -Infinity) || a.name.localeCompare(b.name);
    });
    const people = active.length === 0 ? ['  ○ nobody in the square'] : active.slice(0, STATUS_PARTICIPANT_PREVIEW_LIMIT).map((participant) => {
      const glyph = participant.presence === 'watching'
        ? '◎'
        : participant.activityCount > 0 ? '●' : '○';
      const summary = participant.activityCount > 0
        ? `${participant.activityCount} ${participant.activityCount === 1 ? 'activity' : 'activities'} · ${participant.lastActiveAt === undefined
          ? 'just now'
          : formatRelativeTime(participant.lastActiveAt, result.now)}`
        : `quiet · ${participant.lastActiveAt === undefined ? '—' : formatRelativeTime(participant.lastActiveAt, result.now)}`;
      const showAttention = context.name === undefined || sameName(participant.name, context.name);
      const attention = !showAttention
        ? ''
        : participant.pendingMentionCount > 0
          ? `${participant.pendingMentionCount} attention${participant.pendingMentionCount === 1 ? '' : 's'} waiting`
          : participant.unreadActivityCount > 0
            ? `${participant.unreadActivityCount} change${participant.unreadActivityCount === 1 ? '' : 's'} waiting`
            : 'caught up';
      return `  ${glyph} ${participantIdentity(participant.name)} · ${summary}${attention === '' ? '' : ` · ${attention}`}`;
    });
    if (active.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) {
      people.push(`  ○ … ${active.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more participants`);
      people.push(`» ${result.participants.length <= PARTICIPANTS_MAX_LIMIT
        ? participantsLimitCommand(squarePath, result.participants.length)
        : `${commandPrefix(squarePath)} participants`}`);
    }
    const cap = result.hardCap === null ? 'unlimited' : String(result.hardCap);
    const hold = result.holdActive
      ? `· ${result.holdActor === undefined ? 'someone' : participantIdentity(result.holdActor)} raised a hand${result.holdReason ? ` — ${result.holdReason}` : ''} · ${result.holdAt === undefined
        ? 'just now'
        : formatRelativeTime(result.holdAt, result.now)}`
      : undefined;
    const visible = result.latestAct === undefined
      ? ''
      : renderAmbientEvent(result.latestAct, context.name ?? '', {
          now: result.now,
          preview: 200,
          actNumber: presentation.latestActNumber,
          squareState: presentation.state,
        });
    const latest = visible === ''
      ? [result.latestAct === undefined
        ? '  ○ no public activity yet'
        : '  · latest activity is private to another participant']
      : [`  ${visible.replace(/\n/g, '\n  ')}`];
    if (visible.includes('more chars') && result.latestAct !== undefined) {
      latest.push(`» ${commandPrefix(squarePath)} history --at ${actId(result.latestAct)} -C 2 --no-truncate`);
    }
    const output = [
      `${result.activeCount} active · ${result.doneCount} done · cap ${cap} · throttle ${result.throttlePerMinute === undefined ? 'none' : `${result.throttlePerMinute}/min`}`,
      ...(hold === undefined ? [] : ['', hold]), '', 'around the square', ...people, '', 'latest', ...latest,
    ].join('\n');
    return withPathOutput(squarePath, output, { participantCount: result.activeCount, held: result.holdActive });
    } finally {
      await closeOpenSquare(square);
    }
  },
  present: (result) => process.stdout.write(result),
};

interface InboxIntent { sessionId: string; json: boolean; }
export const inboxCommand: CommandSpec<InboxIntent, string> = {
  parse(argv, context) {
    let sessionId: string | undefined;
    let json = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--for-session') { sessionId = requireValue(argv, index, argv[index]); index += 1; }
      else if (argv[index] === '--json') json = true;
      else usage(context.command);
    }
    if (!sessionId) fail('inbox requires --for-session <session-id>.');
    return { sessionId, json };
  },
  async execute(intent) {
    const inbox = await sessionInbox(intent.sessionId);
    return intent.json ? `${JSON.stringify(inbox)}\n` : inbox.map((membership) => `${membership.name}\t${membership.squarePath}\t${membership.notifications.length}\n`).join('');
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

export const claudeHookCommand = hookCommand(runClaudeHookAsync);
export const codexHookCommand = hookCommand(runCodexHookAsync);
