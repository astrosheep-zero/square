import { runClaudeHookAsync } from '../claude-hook.js';
import { runCodexHookAsync } from '../codex-hook.js';
import { sessionInbox } from '../inbox.js';
import { sweepPendingNotifications } from '../notifications.js';
import { cmdListSquares } from '../list.js';
import { parseActivityId, type ActivitiesOptions, type StoredAct, type WatchOptions, sameName } from '../model.js';
import {
  commandPrefix,
  participantCommandPrefix,
  renderGrepActivitiesView,
  renderEventCli,
  renderAmbientEvent,
  withPathOutput,
} from '../presentation.js';
import { actId, nowMs } from '../runtime.js';
import { cmdStream, cmdStreamNdjson } from '../stream.js';
import { formatRelativeTime, formatTimestamp, parseTimeOrRelative } from '../time.js';
import { cmdWatch } from '../watch.js';
import { openFileApplication } from '../square-file-adapter.js';
import type { HistoryPresentation } from '../square-engine.js';

import {
  type CommandContext,
  type CommandSpec,
  fail,
  parseDurationMs,
  parseNameList,
  parseNonNegativeInteger,
  readStdinSync,
  requireParticipant,
  requireValue,
  usage,
} from './context.js';

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
    if (intent.ndjson) await cmdStreamNdjson(context.squarePath, intent.forName);
    else await cmdStream(context.squarePath);
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
    await cmdWatch(context.squarePath, requireParticipant(context.name), intent);
    await sweepPendingNotifications(context.squarePath);
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

function parseHistory(argv: string[], context: CommandContext): ActivitiesOptions {
  const viewer = context.name;
  let lastN: number | null = 10;
  let lastNExplicit = false;
  let before: number | undefined;
  let after: number | undefined;
  let afterIndex: number | undefined;
  const atIndexes: number[] = [];
  let beforeContext: number | undefined;
  let afterContext: number | undefined;
  let mention: string | undefined;
  let pending = false;
  let full = false;
  let grep: string | undefined;
  let fixed: string | undefined;
  let order: 'asc' | 'desc' | undefined;
  let format: string[] | undefined;
  let json = false;
  const participants: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--limit') {
      const value = argv[index + 1];
      const retry = `${commandPrefix(context.squarePath)} history --limit 30`;
      if (value === undefined || value.startsWith('--')) fail(`✕ --limit needs a positive number\n» ${retry}`);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        fail(`✕ --limit needs a positive number\n» ${retry}`);
      }
      lastN = Number(value);
      lastNExplicit = true;
      index += 1;
    } else if (flag === '--all') {
      lastN = null;
      lastNExplicit = true;
    } else if (flag === '--from') {
      participants.push(...parseNameList(requireValue(argv, index, flag), flag));
      index += 1;
    } else if (flag === '--until') {
      before = parseTimestamp(requireValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === '--since') {
      after = parseTimestamp(requireValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === '--after') {
      afterIndex = parseActRef(requireValue(argv, index, flag), flag);
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
    } else if (flag === '--full') full = true;
    else if (flag === '--mention') {
      mention = requireValue(argv, index, flag);
      index += 1;
    } else if (flag === '--pending') pending = true;
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
  if (pending && !viewer) fail('--pending requires --as <name>.');
  if (grep !== undefined && fixed !== undefined) fail('--grep and --fixed cannot be combined.');
  if (grep === '' || fixed === '') fail('--grep and --fixed require non-empty text.');
  if (!lastNExplicit && (atIndexes.length > 0 || pending)) lastN = null;
  return {
    lastN,
    participants,
    before,
    after,
    afterIndex,
    atIndexes: atIndexes.length === 0 ? undefined : atIndexes,
    beforeContext,
    afterContext,
    mention,
    pending,
    viewer,
    full,
    grep,
    fixed,
    order,
    format,
    json,
  };
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
    reach: act.kind === 'say' ? act.reach ?? null : null,
    reply: act.kind === 'say' && act.reply !== undefined ? actId(act.reply) : null,
  });
}

function renderHistoryProjection(
  projection: HistoryPresentation,
  visible: HistoryPresentation['activities'],
  full: boolean,
  squarePath: string,
  viewer: string,
  mode: 'ambient' | 'archive',
): string {
  const shown = visible.filter((activity) => activity.kind === 'say' || activity.kind === 'done');
  const preview = full ? undefined : 200;
  const chunks: string[] = [];
  for (const activity of shown) {
    const options = {
      preview,
      actNumber: activity.kind === 'say' ? projection.sayNumbers[activity.index] : undefined,
    };
    const rendered = mode === 'archive'
      ? renderEventCli(activity, options)
      : renderAmbientEvent(activity, viewer, options);
    if (rendered !== '') chunks.push(rendered);
    for (const name of projection.presenceAnchors[activity.index] ?? []) chunks.push(`→ ${name} was here`);
  }
  if (chunks.length === 0) return 'latest\n  ○ no public activity in this view';
  if (preview !== undefined && shown.some((activity) =>
    activity.kind === 'say' && activity.body.length > preview && (mode === 'archive' || activity.perception === 'full')
  )) {
    chunks.push(`» ${commandPrefix(squarePath)} history --full`);
  }
  return chunks.join('\n\n');
}

export const historyCommand: CommandSpec<ActivitiesOptions, string> = {
  parse(argv, context) { return parseHistory(argv, context); },
  async execute(options, context) {
    const application = await openFileApplication(context.squarePath, { clock: nowMs });
    try {
      const projection = await application.historyPresentation(options);
      let events = [...projection.activities];
      const searching = options.grep !== undefined || options.fixed !== undefined;
      const totalMatches = searching ? events.length : 0;
      if (options.lastN != null) {
        events = options.order === 'desc'
          ? events.slice(0, options.lastN)
          : events.slice(-options.lastN);
      }
      if (options.json) return events.map((item) => jsonLine(projection.sayNumbers, item)).join('\n') + (events.length > 0 ? '\n' : '');
      if (options.format !== undefined && options.format.length > 0) {
        return events.map((item) => renderFields(projection.sayNumbers, item, options.format!)).join('\n') + (events.length > 0 ? '\n' : '');
      }
      const pattern = options.grep ?? options.fixed;
      const anonymous = options.viewer === undefined;
      const archive = (options.atIndexes !== undefined && options.atIndexes.length > 0)
        || (options.lastN == null && options.full === true)
        || anonymous;
      const output = pattern === undefined || pattern === ''
        ? renderHistoryProjection(projection, events, options.full === true || anonymous, context.squarePath, options.viewer ?? '', archive ? 'archive' : 'ambient')
        : renderGrepActivitiesView(events, totalMatches, options.full, context.squarePath, pattern, options.fixed !== undefined);
      return withPathOutput(context.squarePath, output, { participantCount: projection.participantCount });
    } finally {
      await application.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

export const participantsCommand: CommandSpec<undefined, string> = {
  parse(argv, context) { if (argv.length > 0) usage(context.command); return undefined; },
  async execute(_intent, context) {
    const application = await openFileApplication(context.squarePath, { clock: nowMs });
    try {
      const now = nowMs();
      const participants = await application.participantsPresentation();
      const lines = participants.map((participant) => {
        const glyph = participant.state === 'done' ? '○' : participant.presence === 'watching' ? '◎' : participant.activityCount > 0 ? '●' : '○';
        const state = participant.state === 'done' ? 'done' : participant.presence === 'watching' ? 'catching' : participant.state;
        const last = participant.lastActiveAt === undefined ? '—' : formatRelativeTime(participant.lastActiveAt, now);
        return `  ${glyph} ${participant.name} · ${state} · ${participant.activityCount} ${participant.activityCount === 1 ? 'activity' : 'activities'} · ${last}`;
      });
      const participantCount = participants.filter(
        (participant) => participant.state === 'active'
      ).length;
      return withPathOutput(context.squarePath, ['participants', ...lines].join('\n'), {
        participantCount,
      });
    } finally {
      await application.close();
    }
  },
  present: (result) => process.stdout.write(result),
};

export const statusCommand: CommandSpec<undefined, string> = {
  parse(argv, context) { if (argv.length > 0) usage(context.command); return undefined; },
  async execute(_intent, context) {
    const application = await openFileApplication(context.squarePath, { clock: nowMs });
    try {
      const presentation = await application.statusPresentation();
      const result = presentation.status;
    const active = result.participants.filter((participant) => participant.state === 'active').sort((a, b) => {
      const aViewer = context.name !== undefined && sameName(a.name, context.name);
      const bViewer = context.name !== undefined && sameName(b.name, context.name);
      if (aViewer !== bViewer) return aViewer ? -1 : 1;
      return (b.lastActiveAt ?? -Infinity) - (a.lastActiveAt ?? -Infinity) || a.name.localeCompare(b.name);
    });
    const people = active.length === 0 ? ['  ○ nobody in the square'] : active.map((participant) => {
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
          ? `${participant.pendingMentionCount} mention${participant.pendingMentionCount === 1 ? '' : 's'} waiting`
          : participant.unreadActivityCount > 0
            ? `${participant.unreadActivityCount} change${participant.unreadActivityCount === 1 ? '' : 's'} waiting`
            : 'caught up';
      return `  ${glyph} ${participant.name} · ${summary}${attention === '' ? '' : ` · ${attention}`}`;
    });
    const cap = result.hardCap === null ? 'unlimited' : String(result.hardCap);
    const hold = result.holdActive
      ? `· ${result.holdActor ?? 'someone'} raised a hand${result.holdReason ? ` — ${result.holdReason}` : ''} · ${result.holdAt === undefined
        ? 'just now'
        : formatRelativeTime(result.holdAt, result.now)}`
      : undefined;
    const visible = result.latestAct === undefined
      ? ''
      : renderAmbientEvent(result.latestAct, context.name ?? '', {
          now: result.now,
          preview: 200,
          actNumber: presentation.latestActNumber,
        });
    const latest = visible === ''
      ? [result.latestAct === undefined
        ? '  ○ no public activity yet'
        : '  · latest activity is private to another participant']
      : [`  ${visible.replace(/\n/g, '\n  ')}`];
    if (visible.includes('more chars') && result.latestAct !== undefined) {
      const prefix = context.name === undefined ? commandPrefix(context.squarePath) : participantCommandPrefix(context.squarePath, context.name);
      latest.push(`» ${prefix} history --at ${actId(result.latestAct)} -C 2 --full`);
    }
    const output = [
      `${result.activeCount} active · ${result.doneCount} done · cap ${cap} · throttle ${result.throttlePerMinute === undefined ? 'none' : `${result.throttlePerMinute}/min`}`,
      ...(hold === undefined ? [] : ['', hold]), '', 'around the square', ...people, '', 'latest', ...latest,
    ].join('\n');
    return withPathOutput(context.squarePath, output, { participantCount: result.activeCount, held: result.holdActive });
    } finally {
      await application.close();
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
    execute: () => runHook(readStdinSync()),
    present: (result) => process.stdout.write(result),
  };
}

export const claudeHookCommand = hookCommand(runClaudeHookAsync);
export const codexHookCommand = hookCommand(runCodexHookAsync);
