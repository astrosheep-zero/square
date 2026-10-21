import path from 'node:path';
import { once } from 'node:events';
import { runClaudeMod } from '../claude-mod.js';
import { runCodexHookAsync } from '../codex-hook.js';
import { isSquareError, sameName } from '../model.js';
import type { ActivityId, OperationError, ArchiveRecord, CatchOptions, DiscoveryResult, DiscoveryOptions, HistoryQuery, HistoryObservation, StreamStart } from '../square-facade.js';
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
import { style } from '../tty-style.js';
import { formatRelativeTime, formatTimestamp, parseTimeOrRelative } from '../time.js';
import { discover, inbox, formatActivityId, parseActivityId, CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT, HISTORY_MAX_LIMIT, DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../square-api.js';
import { renderCatchOutcome, renderCatchProgress } from './catch-presentation.js';

import {
  type CommandContext,
  type CommandSpec,
  withSquare, squareInput, now,
  fail,
  parseBoundedLimit,
  parseDurationMs,
  parseNameList,
  parseNonNegativeInteger,
  readStdin,
  requireSquarePath,
  requireValue,
  usage,
} from './context.js';
const STATUS_PARTICIPANT_PREVIEW_LIMIT = 10;
const PARTICIPANTS_DEFAULT_LIMIT = 20;
const PARTICIPANTS_MAX_LIMIT = 100;
const INBOX_DEFAULT_LIMIT = 20;
const INBOX_MAX_LIMIT = 100;
const INBOX_DISPLAY_CHARS = 160;

function inboxDisplay(value: string): string {
  const truncated = truncateChars(value, INBOX_DISPLAY_CHARS - 1);
  return truncated.remaining === 0 ? truncated.text : `${truncated.text}…`;
}

interface HistoryCommandOptions {
  query: HistoryQuery;
  noTruncate: boolean;
  format?: string[];
  json: boolean;
  continuationArgs: string[];
}

function renderSquareList(data: DiscoveryResult, projection: { now: number; depth: number; limit: number }): string {
  const { items, stopped, remaining, next } = data;
  if (data.total === 0) {
    return ['(no squares found)', ...(stopped ? [style('dim', '○ the walk stopped early — deeper squares may still be hiding')] : [])].join('\n') + '\n';
  }
  const lines = ['squares'];
  for (const item of items) {
    const glyph = item.activities > 0 ? '●' : style('dim', '○');
    lines.push(`${glyph} ${inboxDisplay(item.path)}${style('dim', ` · ${formatRelativeTime(item.lastActiveAt, projection.now)} · ${item.participants.length} in the square · ${item.activities} ${item.activities === 1 ? 'activity' : 'activities'}`)}`);
    const context = item.context.slice(0, 2);
    if (context.length === 0) lines.push(`  ${style('dim', 'context')} · (none)`);
    else {
      context.forEach((line, index) => lines.push(`  ${index === 0 ? style('dim', 'context') : '       '} · ${inboxDisplay(line)}`));
      const hidden = item.context.length - context.length;
      if (hidden > 0) lines.push(style('dim', `          · … ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`));
    }
    const participants = item.participants.slice(0, 3);
    const hidden = item.participants.length - participants.length;
    const names = participants.length === 0 ? 'nobody' : participants.map((name) => participantIdentity(inboxDisplay(name))).join(' · ');
    lines.push(`  ${style('dim', 'participants')} · ${names}${hidden > 0 ? style('dim', ` · … ${hidden} more`) : ''}`);
  }
  if (remaining > 0) {
    lines.push(style('dim', stopped ? '  … more squares' : `  … ${remaining} more ${remaining === 1 ? 'square' : 'squares'}`));
    if (next !== undefined) lines.push(`square list --depth ${projection.depth} --limit ${projection.limit} --after ${quoteShell(next)}`);
  }
  if (stopped) lines.push(style('dim', '○ the walk stopped early — deeper squares may still be hiding'));
  return lines.join('\n') + '\n';
}

export const listCommand: CommandSpec<DiscoveryOptions, string> = {
  parse(argv, context) {
    let depth = DEFAULT_LIST_DEPTH;
    let limit = DEFAULT_LIST_LIMIT;
    let after: string | undefined;
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index], value = argv[index + 1];
      if (value === undefined || !['--depth', '--limit', '--after'].includes(flag)) usage(context.command);
      if (flag === '--after') {
        if (after !== undefined || value.length === 0 || path.isAbsolute(value)) usage(context.command);
        after = value;
      } else {
        if (!/^\d+$/.test(value)) usage(context.command);
        const number = Number(value);
        if (!Number.isSafeInteger(number) || (flag === '--depth' ? number > MAX_LIST_DEPTH : number === 0 || number > MAX_LIST_LIMIT)) usage(context.command);
        if (flag === '--depth') depth = number;
        else limit = number;
      }
    }
    return { depth, limit, after };
  },
  async execute(intent, context) {
    const result = await discover(squareInput(context), intent);
    return renderSquareList(result, { now: now(context), depth: intent.depth ?? DEFAULT_LIST_DEPTH, limit: intent.limit ?? DEFAULT_LIST_LIMIT });
  },
  present: (result) => process.stdout.write(result),
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
    if (!intent.ndjson) {
      process.stderr.write(`✕ interactive stream was removed\nsquare --location ${quoteShell(path.resolve(context.cwd, squarePath))} stream --ndjson\n`);
      process.exitCode = 2;
      return;
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    try {
      await withSquare(context, async (square) => {
        for await (const record of square.stream({ recipient: intent.forName, start: intent.start }, { signal: controller.signal })) {
          if (!process.stdout.write(`${JSON.stringify(record)}\n`)) await once(process.stdout, 'drain', { signal: controller.signal });
        }
      }, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) process.exitCode = 130;
      else if (isSquareError(error) && error.code === 'unavailable') {
        process.stderr.write(`square not found: ${squarePath}\n`);
        process.exitCode = 2;
      } else throw error;
    } finally { process.off('SIGINT', interrupt); }
  },
  present: () => {},
};

export const catchCommand: CommandSpec<CatchOptions> = {
  parse(argv, context) {
    let idle: number | undefined;
    let mention: boolean | undefined;
    let limit: number | undefined;
    let id: ActivityId | undefined;
    let replace = false;
    let now = false;
    const participants: string[] = [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--id') {
        if (id !== undefined) fail('✕ catch accepts one --id\nsquare catch --help');
        const value = requireValue(argv, index, '--id');
        if (parseActivityId(value) === undefined) fail('✕ invalid --id: expected an activity id like act/12\nsquare catch --help');
        id = value as ActivityId;
        index += 1;
      } else if (argv[index] === '--from') {
        participants.push(...parseNameList(requireValue(argv, index, argv[index]), argv[index]));
        index += 1;
      } else if (argv[index] === '--idle') {
        idle = parseDurationMs(requireValue(argv, index, argv[index]), argv[index]);
        index += 1;
      } else if (argv[index] === '--mention') {
        mention = true;
      } else if (argv[index] === '--limit') {
        limit = parseBoundedLimit(argv[index + 1], '--limit', CATCH_MAX_LIMIT, `${commandPrefix(requireSquarePath(context))} catch --limit ${CATCH_MAX_LIMIT}`);
        index += 1;
      } else if (argv[index] === '--replace') replace = true;
      else if (argv[index] === '--now') now = true;
      else fail(`✕ catch does not know ${argv[index]}\nsquare catch --help`);
    }
    if (id !== undefined) {
      if (argv.some((flag) => ['--idle', '--from', '--mention', '--limit', '--replace'].includes(flag))) {
        fail('✕ --id cannot be combined with --idle, --from, --mention, --limit or --replace\nsquare catch --help');
      }
      return { id };
    }
    if (idle !== undefined && now) fail('catch accepts --now or --idle, not both.');
    if (replace && idle === undefined) fail('--replace can only be used with --idle.');
    return {
      ...(participants.length > 0 ? { from: participants } : {}),
      ...(mention === undefined ? {} : { mention }),
      limit: limit ?? CATCH_DEFAULT_LIMIT,
      ...(idle === undefined ? {} : { idle }),
      ...(replace ? { replace } : {}),
    };
  },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    try {
      const outcome = await withSquare(context, async (square) => (await square.participant(context.name)).catch({ ...intent, observe: true }, {
        signal: controller.signal,
        onProgress(progress) {
          const line = renderCatchProgress(squarePath, progress);
          if (line !== undefined) process.stderr.write(line);
        },
      }), { signal: controller.signal });
      const rendered = renderCatchOutcome(squarePath, outcome, intent);
      process.stdout.write(rendered.stdout);
      process.exitCode = rendered.exitCode;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      process.stdout.write(withPathOutput(squarePath, '○ you step back — catch stopped'));
      process.exitCode = 130;
    } finally { process.off('SIGINT', interrupt); }
  },
  present: () => {},
};

function parseActRef(value: string, flag: string): number {
  const index = parseActivityId(value);
  if (index === undefined) fail(`Invalid ${flag}: expected an activity id like act/12`);
  return index;
}

function parseTimestamp(value: string, flag: string, now: number): number {
  const timestamp = parseTimeOrRelative(value, now);
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
  let limit: number | undefined;
  let since: number | undefined;
  let after: ActivityId | undefined;
  let before: ActivityId | undefined;
  const at: ActivityId[] = [];
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
      limit = parseBoundedLimit(
        argv[index + 1],
        '--limit',
        HISTORY_MAX_LIMIT,
        `${commandPrefix(squarePath)} history --limit ${HISTORY_MAX_LIMIT}`,
      );
      index += 1;
    } else if (flag === '--from') {
      participants.push(...parseNameList(requireValue(argv, index, flag), flag));
      index += 1;
    } else if (flag === '--since') {
      since = parseTimestamp(requireValue(argv, index, flag), flag, now(context));
      index += 1;
    } else if (flag === '--after') {
      after = formatActivityId(parseActRef(requireValue(argv, index, flag), flag));
      index += 1;
    } else if (flag === '--before') {
      before = formatActivityId(parseActRef(requireValue(argv, index, flag), flag));
      index += 1;
    } else if (flag === '--at') {
      const values = requireValue(argv, index, flag).split(',');
      if (values.some((value) => value === '')) fail(`Invalid ${flag}: expected an activity id like act/12`);
      at.push(...values.map((value) => formatActivityId(parseActRef(value, flag))));
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
  if (before !== undefined && after !== undefined) fail('--before and --after cannot be combined.');
  return {
    query: { limit, from: participants, since, after, before, at: at.length === 0 ? undefined : at,
      contextBefore: beforeContext, contextAfter: afterContext, mention, grep, fixed, order },
    noTruncate, format, json,
    continuationArgs: historyContinuationArgs(argv),
  };
}

function historyContinuationCommand(options: HistoryCommandOptions, squarePath: string, args: string[]): string {
  const full = [...(options.continuationArgs ?? []), ...args];
  return `${commandPrefix(squarePath)} history ${full.map((arg) => arg.startsWith('-') || /^act\/\d+$/.test(arg) || /^\d+$/.test(arg) ? arg : quoteShell(arg)).join(' ')}`;
}

function renderFields(sayNumbers: Readonly<Record<number, number>>, item: ArchiveRecord, fields: string[]): string {
  return fields.map((field) => {
    switch (field) {
      case 'id': return formatActivityId(item.index);
      case 'author':
      case 'actor': return item.actor ?? '';
      case 'ts':
      case 'at': return formatTimestamp(item.at);
      case 'kind': return item.kind;
      case 'body': return 'body' in item && typeof item.body === 'string' ? item.body.replace(/\s+/g, ' ').trim() : '';
      case 'number': return item.kind === 'say' ? String(sayNumbers[item.index]) : '';
      case 'reply': return item.kind === 'say' && item.reply !== undefined ? formatActivityId(item.reply) : '';
      default: return '';
    }
  }).join('\t');
}

function jsonLine(sayNumbers: Readonly<Record<number, number>>, item: ArchiveRecord): string {
  const act = item;
  return JSON.stringify({
    id: formatActivityId(item.index),
    index: item.index,
    kind: act.kind,
    author: act.actor ?? null,
    at: act.at,
    ts: formatTimestamp(act.at),
    body: 'body' in act && typeof act.body === 'string' ? act.body : '',
    number: act.kind === 'say' ? sayNumbers[act.index] : null,
    mentions: act.kind === 'say' ? [...(act.mentions ?? [])] : [],
    reach: act.kind === 'say' ? act.reach ?? null : null,
    reply: act.kind === 'say' && act.reply !== undefined ? formatActivityId(act.reply) : null,
  });
}

function renderHistoryProjection(
  projection: HistoryObservation,
  visible: HistoryObservation['visibleActivities'],
  noTruncate: boolean,
  squarePath: string,
): string {
  const shown = visible;
  const preview = noTruncate || shown.length <= 1 ? undefined : 200;
  const chunks: string[] = [];
  // Presence anchors collect into one closing line instead of interrupting the page.
  const anchored: string[] = [];
  for (const activity of shown) {
    const options = {
      preview,
      actNumber: activity.kind === 'say' ? projection.sayNumbers[activity.index] : undefined,
    };
    const rendered = renderEventCli(activity, options);
    if (rendered !== '') chunks.push(rendered);
    for (const participant of projection.presenceAnchors[activity.index] ?? []) {
      if (!anchored.some((existing) => sameName(existing, participant))) anchored.push(participant);
    }
  }
  if (chunks.length === 0) return 'latest\n  ○ no public activity in this view';
  if (preview !== undefined && shown.some((activity) => activity.kind === 'say' && activity.body.length > preview)) {
    chunks.push(`${commandPrefix(squarePath)} history --no-truncate`);
  }
  if (anchored.length > 0) chunks.push(renderPresenceAnchor(anchored));
  return chunks.join('\n\n');
}

export const historyCommand: CommandSpec<HistoryCommandOptions, string> = {
  parse(argv, context) { return parseHistory(argv, context); },
  async execute(options, context) {
    const squarePath = requireSquarePath(context);
    let outcome;
    try { outcome = await withSquare(context, (square) => square.history({ ...options.query, observe: true })); }
    catch (error) {
      const bounds = (error as OperationError | null)?.operation?.historyBounds;
      if (bounds !== undefined) fail(`✕ history is capped at ${bounds.maxLimit} activities\n${historyContinuationCommand(options, squarePath, ['--limit', String(bounds.maxLimit)])}`);
      throw error;
    }
    const projection = outcome.observation!;
    const events = projection.activities;
    if (options.json) return events.map((item) => jsonLine(projection.sayNumbers, item)).join('\n') + (events.length > 0 ? '\n' : '');
    if (options.format !== undefined && options.format.length > 0) {
      return events.map((item) => renderFields(projection.sayNumbers, item, options.format!)).join('\n') + (events.length > 0 ? '\n' : '');
    }
    const pattern = options.query.grep ?? options.query.fixed;
    const output = pattern === undefined || pattern === ''
      ? renderHistoryProjection(projection, projection.visibleActivities, options.noTruncate, squarePath)
      : renderGrepActivitiesView(projection.visibleActivities, projection.totalMatches, options.noTruncate, squarePath, pattern, options.query.fixed !== undefined, () => 'full');
    const next = projection.continuation;
    const continuation = next === undefined ? '' : `\n\n${historyContinuationCommand(options, squarePath, [`--${next.direction}`, next.cursor, '--limit', String(next.limit)])}`;
    return withPathOutput(squarePath, output + continuation, { participantCount: projection.standingCount });
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
    const data = await withSquare(context, (square) => square.participants({ observe: true }));
    const projection = data.observation!;
    const now = projection.now;
    const participants = data.participants;
    const lines = participants.slice(0, intent.limit).map((participant) => {
      const glyph = participant.state === 'done' ? '○' : participant.presence === 'watching' ? '◎' : participant.activityCount > 0 && projection.classificationByName[participant.name] === 'here' ? '●' : '○';
      const state = participant.state === 'done' ? 'done' : participant.presence === 'watching' ? 'catching' : participant.state;
      const last = participant.lastActiveAt === undefined ? '—' : formatRelativeTime(participant.lastActiveAt, now);
      return `  ${glyph} ${participant.name}${style('dim', ` · ${state} · ${participant.activityCount} ${participant.activityCount === 1 ? 'activity' : 'activities'} · ${last}`)}`;
    });
    const tail = participants.length <= intent.limit
      ? []
      : [
          style('dim', `  ○ ${lines.length} of ${participants.length} participants shown`),
          ...(participants.length <= PARTICIPANTS_MAX_LIMIT ? [
            `${participantsLimitCommand(squarePath, participants.length)}`,
          ] : []),
        ];
    return withPathOutput(squarePath, ['participants', ...lines, ...tail].join('\n'), {
      participantCount: projection.standingCount,
    });
  },
  present: (result) => process.stdout.write(result),
};

export const statusCommand: CommandSpec<undefined, string> = {
  parse(argv, context) { if (argv.length > 0) usage(context.command); return undefined; },
  async execute(_intent, context) {
    const squarePath = requireSquarePath(context);
    const result = await withSquare(context, (square) => square.status({ viewer: context.name, observe: true }));
    const presentation = result.observation!;
    const participantsByName = new Map(result.participants.map((participant) => [participant.name, participant]));
    const orderedHere = presentation.orderedHereNames.map((name) => participantsByName.get(name)!);
    const lingering = presentation.lingeringCount;
    const people: string[] = [];
    if (result.activeCount === 0) {
      people.push('  ○ nobody in the square');
    } else {
      if (orderedHere.length === 0) people.push('  ○ nobody here right now');
      people.push(...orderedHere.slice(0, STATUS_PARTICIPANT_PREVIEW_LIMIT).map((participant) => {
        const glyph = participant.presence === 'watching'
          ? '◎'
          : participant.activityCount > 0 ? '●' : '○';
        const summary = participant.presence === 'watching'
          ? 'is nearby · catching'
          : participant.activityCount > 0
            ? `is nearby · ${formatRelativeTime(participant.lastActiveAt ?? result.now, result.now)}`
            : `is nearby · quiet · ${participant.lastActiveAt === undefined ? 'just now' : formatRelativeTime(participant.lastActiveAt, result.now)}`;
        const showAttention = presentation.attentionNames.includes(participant.name);
        const attention = !showAttention
          ? ''
          : participant.pendingMentionCount > 0
            ? `${participant.pendingMentionCount} ${participant.pendingMentionCount === 1 ? 'mention' : 'mentions'} waiting`
            : participant.unreadActivityCount > 0
              ? `${participant.unreadActivityCount} change${participant.unreadActivityCount === 1 ? '' : 's'} waiting`
              : 'caught up';
        return `  ${glyph} ${participantIdentity(participant.name)}${style('dim', ` ${summary}${attention === '' ? '' : ` · ${attention}`}`)}`;
      }));
      const unshown = Math.max(0, orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT) + lingering;
      if (orderedHere.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) {
        people.push(`  ○ … ${orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more here`);
      }
      if (lingering > 0) people.push(`  ○ … ${lingering} lingering`);
      if (unshown > 0) {
        people.push(`${presentation.knownParticipantCount <= PARTICIPANTS_MAX_LIMIT
          ? participantsLimitCommand(squarePath, presentation.knownParticipantCount)
          : `${commandPrefix(squarePath)} participants`}`);
      }
    }
    const cap = result.hardCap === null ? 'unlimited' : `${result.hardCap} each`;
    const holdTime = result.hold?.at === undefined ? 'just now' : formatRelativeTime(result.hold.at, result.now);
    const hold = result.hold !== null
      ? `· ${result.hold.by === undefined ? 'someone' : participantIdentity(result.hold.by)} raised a hand${result.hold.reason ? ` — ${result.hold.reason}` : ''}${style('dim', ` · ${holdTime}`)}`
      : undefined;
    const visible = result.latestActivity === undefined
      ? { text: '', bodyClipped: false }
      : renderAmbientEventFacts(result.latestActivity, presentation.viewer, {
          now: result.now,
          preview: 200,
          actNumber: presentation.latestActNumber,
          perception: presentation.latestPerception,
        });
    const latest = visible.text === ''
      ? [result.latestActivity === undefined
        ? '  ○ no public activity yet'
        : '  · the latest words were meant for other ears']
      : [`  ${visible.text.replace(/\n/g, '\n  ')}`];
    // Presence events after the latest public act: otherwise the roster can say someone is
    // here while the latest line shows them leaving, with nothing to reconcile the two.
    for (const { activity, rejoined } of presentation.joins) {
      latest.push(style('dim', `  → ${participantIdentity(activity.actor!)} ${rejoined ? 'stepped back in' : 'stepped in'} · ${formatRelativeTime(activity.at, result.now)}`));
    }
    if (presentation.joinCount > 3) latest.push(style('dim', `  → … ${presentation.joinCount - 3} more stepped in`));
    if (visible.bodyClipped && result.latestActivity !== undefined) {
      latest.push(`${commandPrefix(squarePath)} history --at ${result.latestActivity.id} -C 2 --no-truncate`);
    }
    const counts = [
      `${orderedHere.length} here`,
      ...(lingering > 0 ? [`${lingering} lingering`] : []),
      `${result.doneCount} done`,
      `cap ${cap}`,
      `throttle ${result.throttlePerMinute === undefined ? 'none' : `${result.throttlePerMinute}/min`}`,
    ].join(' · ');
    const output = [
      style('dim', counts),
      ...(hold === undefined ? [] : ['', hold]), '', style('dim', 'around the square'), ...people, '', style('dim', 'latest'), ...latest,
    ].join('\n');
    return withPathOutput(squarePath, output, { participantCount: presentation.standingCount, held: presentation.held });
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
    const retry = `square inbox --for-session ${quoteShell(sessionId)} --limit ${INBOX_MAX_LIMIT}${json ? ' --json' : ''}`;
    if (duplicateLimit) fail(`✕ inbox accepts one --limit\n${retry}`);
    const limit = hasLimit
      ? parseBoundedLimit(limitValue, '--limit', INBOX_MAX_LIMIT, retry)
      : INBOX_DEFAULT_LIMIT;
    return { sessionId, json, limit };
  },
  async execute(intent, context) {
    const data = await inbox(squareInput(context), intent.sessionId, { limit: intent.limit });
    const rows = data.rows.map((membership) => ({
      namePreview: inboxDisplay(membership.name),
      squarePathPreview: inboxDisplay(membership.squarePath),
      pending: membership.pending,
    }));
    if (intent.json) return `${JSON.stringify({ rows, total: data.total })}\n`;
    return [
      ...rows.map((row) => `${row.namePreview}\t${row.squarePathPreview}\t${row.pending}\n`),
      ...(rows.length < data.total ? [`${rows.length} of ${data.total} memberships shown\n`] : []),
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
