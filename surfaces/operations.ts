import path from 'node:path';
import { z } from 'zod/v4';
import { ACTIVITY_ID_PATTERN, requireOwner, requireJoinName, selectOwnSeat, HISTORY_MAX_LIMIT, PERCEIVE_MAX_LIMIT, PERCEIVE_DEFAULT_LIMIT, DEFAULT_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_DEPTH, MAX_LIST_LIMIT, discover, muteDeliveryLedger, unmuteDeliveryLedger, Square, type Participant } from '../api/square-api.js';
import { parseDurationMs, parseTimeOrRelative, formatTimestamp } from '../core/time.js';
import { SquareError, parseParticipantList } from '../core/model.js';
import type { ActivityId, DiscoveryResult, ExpressOptions, ExpressResult, HistoryQuery, HistoryResult, JoinResult, LifecycleResult, ListenerChangeResult, MuteResult, OperationControl, OperationError, Owner, PerceiveOptions, PerceiveResult, StatusResult, WakeAddress } from '../api/types.js';

export type PresentationSurface = 'cli' | 'tool';
export type Input = Record<string, unknown>;
export type ListenerVerb = 'listen' | 'unlisten' | 'ignore';
export interface Suggestion { operation: string; args?: Input; owner?: string; help?: true }
interface Scene { surface?: PresentationSurface }
interface OperationText {
  list(result: DiscoveryResult, projection: Scene & { now: number; depth: number; limit: number }): string;
  join(result: JoinResult, owner?: Owner, surface?: PresentationSurface): string | undefined;
  express(location: string, result: ExpressResult, owner?: Owner, surface?: PresentationSurface): string | undefined;
  perceive(location: string, result: PerceiveResult, options: PerceiveOptions, owner?: Owner, surface?: PresentationSurface): string;
  history(location: string, result: HistoryResult, options: Scene & { query: HistoryQuery; full?: boolean; filters: Input }): string | undefined;
  attention(location: string, action: ListenerVerb, result: ListenerChangeResult): string | undefined;
  done(location: string, result: LifecycleResult): string | undefined;
  status(location: string, result: StatusResult, options: Scene): string | undefined;
  mute(location: string | undefined, action: 'mute' | 'unmute', result: MuteResult): string;
  perceiveProgress(replaced: boolean): string;
  perceiveStopped(location: string): string;
  field(operation: string, field: string, surface?: PresentationSurface): string;
  action(suggestion: Suggestion, surface?: PresentationSurface): string;
}
type Identity = () => { owner?: Owner; wakeAddress?: WakeAddress };
type OpenSquare = (control?: OperationControl) => Promise<Square>;
export type ExpressFromCli = (open: OpenSquare, input: ExpressionInput, identity: Identity, ownerFlag?: Owner, invalidReply?: string) => Promise<string>;
export interface OperationBinding {
  surface: PresentationSurface;
  identity: Identity;
  text: OperationText;
  expressFromCli?: ExpressFromCli;
  stdin?: { tty: boolean; read: () => Promise<string> };
  cwd?: string;
  ledgerLocation?: string;
  clock: () => number;
  ownerFlag?: Owner;
  opened?: (location: string) => void;
  exit?: (code: number) => void;
  progress?: (text: string) => void;
  refuse?: (message: string) => never;
}

type Coordinates = { location?: string; as?: string };
type FieldHint = { short?: string; preferShort?: boolean; flag?: string; positional?: boolean; value?: string; bare?: boolean; repeat?: boolean; split?: (value: string) => string[]; once?: boolean };
interface CliHints {
  fields?: Record<string, FieldHint>;
  prepare?: (input: Input, stdinIsTTY: boolean) => void;
  invalid?: (input: Input, error: z.ZodError, binding: OperationBinding) => Promise<string> | undefined;
  interrupted?: (location: string, text: OperationText) => string;
}
interface Projection {
  name: string;
  aliases?: readonly string[];
  summary?: string;
  fixed?: Input;
}
interface Operation extends CliHints {
  name: string;
  summary: string;
  group: 'participant' | 'host';
  inputSchema: z.ZodObject;
  cliSchema: z.ZodObject;
  projections: readonly Projection[];
  run(binding: OperationBinding, args: Input, control: OperationControl): Promise<string>;
}

const location = z.string().describe('Path to the .square file.');
const requiredParticipant = z.string().describe('Your name in the square.');
const participant = requiredParticipant.optional().describe(requiredParticipant.description!);
const activityId = z.string().regex(ACTIVITY_ID_PATTERN, 'must be an activity id like act/12') as z.ZodType<ActivityId>;
const from = z.array(z.string()).optional().describe('Only what these participants said.');
const fromHint = { split: parseParticipantList, bare: true, value: 'names' };
const body = z.string().describe('What you say or do. Markdown works; *asterisks* mark an action.');
const bodyHint = { positional: true, value: 'body | -' };
const observe = { observe: true } as const;

function operation<S extends z.ZodRawShape, C extends z.ZodRawShape = {}>(
  name: string, summary: string, shape: S, hints: CliHints & {
    location?: false | string; as?: z.ZodType<string | undefined>; group?: Operation['group']; aliases?: readonly string[];
    projections?: readonly Projection[]; cliShape?: C;
    check?: (input: Coordinates & z.output<z.ZodObject<S>>, issue: (field: string, message: string) => void) => void;
    cliCheck?: (input: Coordinates & z.output<z.ZodObject<C>>, issue: (field: string, message: string) => void) => void;
  },
  run: (binding: OperationBinding, input: Coordinates & Omit<z.output<z.ZodObject<S>>, keyof C> & z.output<z.ZodObject<C>>, control: OperationControl) => Promise<string | undefined>,
): Operation {
  const fields = { ...shape, ...(hints.as === undefined ? {} : { as: hints.as }),
    ...(hints.location === false ? {} : { location: hints.location === undefined ? location : location.optional().describe(hints.location) }) };
  const check = (cli: boolean) => (input: Input, ctx: z.RefinementCtx) => {
    const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
    hints.check?.(input as Coordinates & z.output<z.ZodObject<S>>, issue);
    if (cli) hints.cliCheck?.(input as Coordinates & z.output<z.ZodObject<C>>, issue);
  };
  const inputSchema = z.strictObject(fields).superRefine(check(false));
  const cliSchema = z.strictObject({ ...fields, ...hints.cliShape }).superRefine(check(true));
  return { name, summary, group: hints.group ?? 'participant', ...hints, inputSchema, cliSchema,
    projections: hints.projections ?? [{ name, aliases: hints.aliases }],
    async run(binding, args, control) { return await run(binding, args as Parameters<typeof run>[1], control) ?? ''; } };
}

function open(binding: OperationBinding, location: string | undefined, control?: OperationControl) {
  return Square.at({ cwd: binding.cwd, path: location, ledgerLocation: binding.ledgerLocation, clock: binding.clock }, control);
}
async function inSquare(binding: OperationBinding, args: Coordinates, control: OperationControl,
  work: (square: Square, location: string) => Promise<string | undefined>, trackLocation = true,
) {
  const square = await open(binding, args.location, control);
  if (trackLocation) binding.opened?.(square.location);
  try { return await work(square, binding.surface === 'cli' ? args.location! : square.location); }
  finally { await square.close(); }
}

export function issueText(error: z.ZodError): string {
  return error.issues.map(issue => {
    const field = issue.path.join('.');
    switch (issue.code) {
      case 'invalid_type': return `${field} must be ${issue.expected === 'int' ? 'an integer' : issue.expected === 'array' ? 'an array' : `a ${issue.expected}`}`;
      case 'too_big': return `${field} must be at most ${issue.maximum}`;
      case 'too_small': return `${field} must be at least ${issue.minimum}`;
      case 'invalid_value': return `${field} must be one of ${issue.values.join(', ')}`;
      case 'unrecognized_keys': return `unknown ${issue.keys.length === 1 ? 'field' : 'fields'}: ${issue.keys.join(', ')}`;
      default: return `${field} ${issue.message}`;
    }
  }).join('\n');
}

type HistoryInput = Omit<HistoryQuery, 'search' | 'cursor' | 'since'> & {
  search?: string; regex?: boolean; before?: ActivityId; after?: ActivityId; since?: string;
};
function historyQuery({ search, regex, before, after, since, ...query }: HistoryInput, now: number, label: string): HistoryQuery {
  const sinceMs = since === undefined ? undefined : parseTimeOrRelative(since, now);
  if (sinceMs !== undefined && !Number.isFinite(sinceMs)) throw new SquareError('invalid_args', `Invalid ${label} timestamp: ${since}`);
  return { ...query, since: sinceMs,
    search: search === undefined ? undefined : { text: search, mode: regex ? 'regex' : 'literal' },
    cursor: after !== undefined ? { id: after, direction: 'after' } : before === undefined ? undefined : { id: before, direction: 'before' },
  };
}

function mute(binding: OperationBinding, input: Coordinates & { duration?: string }, control: OperationControl) {
  const { location, duration, as } = input;
  const durationMs = duration === undefined ? undefined : parseDurationMs(duration, 'duration');
  const verb = durationMs === undefined ? 'unmute' : 'mute';
  if (location === undefined) {
    const options = { ledgerLocation: binding.ledgerLocation, clock: binding.clock };
    return (durationMs === undefined ? unmuteDeliveryLedger(options, control) : muteDeliveryLedger({ ...options, durationMs }, control))
      .then(result => binding.text.mute(undefined, verb, result));
  }
  return inSquare(binding, input, control, async (square, location) => {
    const seat = await selectOwnSeat(square, binding.identity().owner, as);
    return binding.text.mute(location, verb, durationMs === undefined
      ? await seat.unmute(observe, control) : await seat.mute({ durationMs }, observe, control));
  }, false);
}
function muteHints(verb: 'mute' | 'unmute') {
  return { location: `Path to the .square file. Omit to ${verb} the entire ledger.`, as: participant,
    check(input: Coordinates, issue: (key: string, message: string) => void) {
      if (input.location === undefined && input.as !== undefined) issue('as', `needs a square location for ${verb}`);
    } };
}

interface ExpressionInput extends Coordinates {
  body?: string; metadata?: string; mentions?: string[]; reply?: string; noMention?: boolean; force?: boolean; noWait?: boolean;
}
function cliExpression(binding: OperationBinding, input: ExpressionInput, invalidReply?: string): Promise<string> {
  return binding.expressFromCli!(control => open(binding, input.location, control), input, binding.identity, binding.ownerFlag, invalidReply);
}

export function sendExpression(participant: Participant, body: string | undefined, options: ExpressOptions, control: OperationControl) {
  return participant.express(body, { ...options, ...observe }, control);
}

export const OPERATIONS: readonly Operation[] = [
  operation('list', 'Find nearby squares, including your joined names and what is waiting for them.', {
    depth: z.number().int().min(0).max(MAX_LIST_DEPTH).optional().describe('How many directory levels to explore (default 4).'),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe('How many squares per page (default 20).'),
    after: z.string().min(1).optional().describe('Continue after this relative square path.'),
  }, { location: false, group: 'host', aliases: ['ls'], fields: { after: { once: true, value: 'path' } },
    cliCheck(input, issue) { if (typeof input.after === 'string' && path.isAbsolute(input.after)) issue('after', 'must be a relative path'); },
  }, async (binding, options, control) => {
    let owner;
    try { owner = binding.identity().owner; }
    catch (error) { if (binding.surface !== 'cli') throw error; }
    const { cwd, ledgerLocation, clock, surface } = binding;
    const result = await discover({ cwd }, { ...options, owner, ledgerLocation, clock }, control);
    return binding.text.list(result, { now: clock(), depth: options.depth ?? DEFAULT_LIST_DEPTH, limit: options.limit ?? DEFAULT_LIST_LIMIT, surface });
  }),
  operation('join', 'Step into the square under your name and see what was said most recently.', {
    takeover: z.boolean().optional().describe('Claim this name from another session.'),
    last: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe('How many recent public activities to show on arrival (default 10).'),
  }, { as: requiredParticipant }, (binding, { as, location, ...options }, control) =>
    inSquare(binding, { location }, control, async square => {
      const identity = binding.identity();
      return binding.text.join(await square.join(requireJoinName(as), { ...identity, owner: requireOwner(identity.owner), ...options, ...observe }, control), binding.ownerFlag, binding.surface);
    })),
  operation('express', 'Speak or act in the square. Plain words, half-formed ideas and *actions* all belong here. Said to no one in particular, your words reach those who listen to you.', {
    body,
    mentions: z.array(z.string()).optional().describe('Who you are speaking to. An @name in the body that matches someone here counts too.'),
    reply: activityId.optional().describe('The activity you are answering, like act/12.'),
    noMention: z.boolean().optional().describe('Leave @names in the body as plain text.'),
    force: z.boolean().optional().describe('Speak now, even if something reached you that you have not perceived yet.'),
    noWait: z.boolean().optional().describe('If you are speaking too fast, return at once instead of waiting.'),
  }, { as: participant, fields: { body: bodyHint, mentions: { flag: '--mention', repeat: true, value: 'name' }, reply: { value: 'activity-id' }, force: { short: '-f' }, metadata: { value: 'json' } },
    cliShape: { body: body.optional(), metadata: z.string().refine(text => { try { JSON.parse(text); return true; } catch { return false; } }, 'must be JSON').optional().describe('Attach a JSON object to the activity.') },
    prepare(input, tty) { if (input.body === undefined && input.metadata === undefined && !tty) input.body = '-'; },
    cliCheck(input, issue) { if (input.body === undefined && input.metadata === undefined) issue('body', 'is required unless metadata is supplied'); },
    invalid(input, error, binding) {
      // An invalid reply still owes the CLI a draft and an executable repair, without sending anything.
      if (error.issues.length === 1 && error.issues[0].path[0] === 'reply') return cliExpression(binding, input, issueText(error));
    },
  }, (binding, input, control) => {
    if (binding.surface === 'cli') return cliExpression(binding, input);
    const { body, as, location, metadata: _metadata, ...options } = input;
    return inSquare(binding, { location }, control, async (square, location) => binding.text.express(location,
      await sendExpression(await selectOwnSeat(square, binding.identity().owner, as), body, options, control), binding.ownerFlag, binding.surface));
  }),
  operation('perceive', 'Take in what reached you since you last looked: mentions, replies, and words from those you listen to.', {
    id: activityId.optional().describe('Open this one activity in full, like act/12.'),
    wait: z.string().optional().describe('If nothing is waiting, block until something arrives or this much time passes, like "30s".'),
    from,
    mention: z.boolean().optional().describe('Only what was addressed to you.'),
    limit: z.number().int().min(1).max(PERCEIVE_MAX_LIMIT).optional().describe('At most this many at once (default 10).'),
    takeover: z.boolean().optional().describe('Take over from another perceive already waiting for this participant.'),
  }, { as: participant, fields: { id: { once: true, value: 'activity-id' }, from: fromHint, wait: { bare: true, value: 'duration' } },
    check({ id, wait, from, mention, limit, takeover }, issue) {
      if (id !== undefined && [wait, from, mention, limit, takeover].some(value => value !== undefined)) issue('id', 'cannot be combined with wait, from, mention, limit or takeover');
      else if (takeover !== undefined && wait === undefined) issue('takeover', 'requires wait');
    },
    interrupted: (location, text) => text.perceiveStopped(location),
  }, (binding, { location, as, wait, ...args }, control) => {
    const options = { ...args, ...(wait === undefined ? {} : { wait: parseDurationMs(wait, binding.text.field('perceive', 'wait', binding.surface)) }) };
    const renderOptions = options.id === undefined ? { ...options, limit: options.limit ?? PERCEIVE_DEFAULT_LIMIT } : options;
    return inSquare(binding, { location }, control, async (square, location) => {
      const result = await (await selectOwnSeat(square, binding.identity().owner, as)).perceive({ ...renderOptions, ...observe }, {
        ...control, onProgress(progress) {
          control.onProgress?.(progress);
          if (progress.kind === 'perceive-started' && progress.replacementRequested)
            binding.progress?.(binding.text.perceiveProgress(progress.replaced));
        },
      });
      binding.exit?.(result.reason === 'already-active' || result.reason === 'capped' ? 1 : 0);
      return binding.text.perceive(location, result, renderOptions, binding.ownerFlag, binding.surface);
    });
  }),
  operation('history', 'Look back at what was said without taking anything in.', {
    from,
    since: z.string().optional().describe('Only activities after this ISO timestamp or relative duration (like "10m").'),
    at: z.array(activityId).min(1).optional().describe('Center on these activity ids, like ["act/12"].'),
    context: z.number().int().min(0).max(HISTORY_MAX_LIMIT).optional().describe('Activities of context before and after each "at" activity.'),
    mention: z.string().optional().describe('Only what was addressed to this participant.'),
    search: z.string().optional().describe('Only activities containing this text in their names, ids or words.'),
    regex: z.boolean().optional().describe('Treat search as a regular expression.'),
    order: z.enum(['asc', 'desc']).optional().describe('"asc" for oldest first (default), "desc" for newest first.'),
    full: z.boolean().optional().describe('Show full activity bodies even when multiple activities are returned.'),
    before: activityId.optional().describe('The page just before this activity, like act/12.'),
    after: activityId.optional().describe('The page just after this activity, like act/12.'),
    limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe('How many per page (default 10).'),
  }, { fields: { context: { short: '-C', preferShort: true }, from: { ...fromHint, bare: false }, at: { value: 'activity-ids', bare: true }, after: { value: 'activity-id' }, before: { value: 'activity-id' }, since: { value: 'time' }, mention: { value: 'name' } },
    check({ before, after }, issue) { if (before !== undefined && after !== undefined) issue('before', 'cannot be combined with after'); },
    cliCheck(input, issue) { if (input.search === '') issue('search', 'requires non-empty text'); },
  }, (binding, { location, as: _as, ...options }, control) => {
    const { surface } = binding;
    const { full, ...args } = options;
    const query = historyQuery(args, binding.clock(), binding.text.field('history', 'since', surface));
    const { limit: _limit, before: _before, after: _after, ...filters } = options;
    if (!full) delete filters.full;
    if (surface === 'tool' && query.since !== undefined) filters.since = formatTimestamp(query.since);
    return inSquare(binding, { location }, control, async (square, location) =>
      binding.text.history(location, await square.history({ ...query, ...observe }, control), { query, full, filters, surface })
    ).catch(error => {
      const bounds = (error as OperationError | null)?.operation?.historyBounds;
      if (bounds === undefined || binding.refuse === undefined) throw error;
      return binding.refuse(`✕ history is capped at ${bounds.maxLimit} activities\n${binding.text.action({ operation: 'history', args: { location, ...filters, limit: bounds.maxLimit } })}`);
    });
  }),
  operation('attention', 'Turn toward someone or away from them. Listen: hear everything they say, even to others. Unlisten: stop listening to them. Ignore: stop hearing their future activity.', {
    action: z.enum(['listen', 'unlisten', 'ignore']).describe('"listen", "unlisten" or "ignore".'),
    target: z.string().describe('The participant to turn toward or away from.'),
  }, { as: participant, fields: { target: { positional: true, value: 'participant' } }, projections: [
    { name: 'listen', fixed: { action: 'listen' }, summary: "Turn an ear toward one participant's future activity." },
    { name: 'unlisten', fixed: { action: 'unlisten' }, summary: "Stop listening to one participant's future activity." },
    { name: 'ignore', fixed: { action: 'ignore' }, summary: "Stop hearing one participant's future activity." },
  ] }, (binding, { location, as, action, target }, control) => inSquare(binding, { location }, control, async (square, location) =>
    binding.text.attention(location, action, await (await selectOwnSeat(square, binding.identity().owner, as))[action](target, observe, control)))),
  operation('done', 'Step out of the square.', {}, {
    as: participant, cliShape: { body: z.string().optional().describe('Leave with these parting words.') }, fields: { body: bodyHint },
  }, async (binding, { location, as, body }, control) => {
    if (binding.stdin && (body === '-' || (!body && !binding.stdin.tty))) body = await binding.stdin.read();
    return inSquare(binding, { location }, control, async (square, location) =>
      binding.text.done(location, await (await selectOwnSeat(square, binding.identity().owner, as)).done(body, observe, control)));
  }),
  operation('status', 'Look around the square: who is here, the latest activity, and who you listen to.', {}, {
    as: z.string().optional().describe('Whose listening to show.'),
  }, (binding, { location, as }, control) => inSquare(binding, { location }, control, async (square, location) => {
    const viewer = (await selectOwnSeat(square, binding.identity().owner, as, { optional: true }))?.name;
    return binding.text.status(location, await square.status({ viewer, ...observe }, control), { surface: binding.surface });
  })),
  operation('mute', 'Step back from notifications for a while. Whatever reaches you stays waiting for perceive.', {
    duration: z.string().describe('How long to pause automatic notifications, like "30m" or "2h".'),
  }, { ...muteHints('mute'), fields: { duration: { positional: true, bare: true } } }, mute),
  operation('unmute', 'Resume automatic notifications early.', {}, muteHints('unmute'), mute),
];

export function fieldFlag(field: string): string {
  return `--${field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

export const CLI_OPERATIONS = OPERATIONS.flatMap(operation => operation.projections.map(projection => {
  const fields = Object.entries(operation.cliSchema.shape).filter(([key]) => !Object.hasOwn(projection.fixed ?? {}, key)).map(([key, schema]) => {
    const hint = operation.fields?.[key];
    const bareSchema = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
    return { key, schema, required: !(schema instanceof z.ZodOptional), flag: hint?.flag ?? fieldFlag(key), ...hint,
      kind: bareSchema instanceof z.ZodBoolean ? 'boolean' : bareSchema instanceof z.ZodNumber ? 'number' : bareSchema instanceof z.ZodArray ? 'array' : 'string',
      value: hint?.value ?? (bareSchema instanceof z.ZodEnum ? bareSchema.options.join('|') : bareSchema instanceof z.ZodNumber ? 'N' : key === 'location' ? 'square' : key === 'as' ? 'name' : key),
    } as const;
  });
  return { ...projection, names: [projection.name, ...projection.aliases ?? []], summary: projection.summary ?? operation.summary, operation, fields };
}));