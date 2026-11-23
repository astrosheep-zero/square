import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { parseActivityId, PAGE_CAP, ACTIVITY_ID_PATTERN, DEFAULT_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_DEPTH,
  PERCEIVE_DEFAULT_LIMIT, type ActivityId } from '../core/square-core.js';
import { parseDurationMs, parseTimeOrRelative } from '../core/time.js';
import { compileSearchPattern, historySearch } from '../core/search.js';
import { SquareError, parseParticipantList, type ActivityMetadata, type Owner, type WakeAddress } from '../core/model.js';
import type { Square, Participant } from '../api/square-api.js';
import type { DiscoveryResult, ExpressResult, HistoryResult, JoinResult, LifecycleResult, ListenerChangeResult, MuteResult, OperationControl, PerceiveResult, StatusResult } from '../api/types.js';

export type PresentationSurface = 'cli' | 'tool';
export type Input = Record<string, unknown>;
export interface Suggestion { operation: string; args?: Input; owner?: string; help?: true; absoluteLocation?: true }
interface Scene { surface?: PresentationSurface }
interface OperationText {
  list(result: DiscoveryResult, projection: Scene & { now: number; depth: number; limit: number }): string;
  join(result: JoinResult, owner?: Owner, surface?: PresentationSurface): string | undefined;
  express(location: string, result: ExpressResult, owner?: Owner, surface?: PresentationSurface): string | undefined;
  perceive(location: string, result: PerceiveResult, options: PerceiveOptions, owner?: Owner, surface?: PresentationSurface): string;
  history(location: string, result: HistoryResult, options: Scene & { query: HistoryQuery }): string | undefined;
  attention(location: string, state: AttentionInput['state'], result: ListenerChangeResult): string | undefined;
  done(location: string, result: LifecycleResult): string | undefined;
  status(location: string, result: StatusResult, options: Scene): string | undefined;
  mute(location: string | undefined, result: MuteResult): string;
  perceiveProgress(replaced: boolean): string;
  perceiveStopped(location: string): string;
}
type Identity = () => { owner?: Owner; wakeAddress?: WakeAddress };
type OpenSquare = (control?: OperationControl) => Promise<Square>;
export type ExpressFromCli = (open: OpenSquare, input: ExpressionInput, identity: Identity, ownerFlag?: Owner, invalidReply?: string) => Promise<string>;
export interface OperationBinding {
  api: typeof import('../api/square-api.js');
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
const activityId = z.string().regex(ACTIVITY_ID_PATTERN, { error: 'must be an activity id like act/12', abort: true })
  .refine(id => parseActivityId(id) !== undefined, 'must be a representable activity id') as z.ZodType<ActivityId>;
const from = z.array(z.string()).optional().describe('Only what these participants said.');
const fromHint = { split: parseParticipantList, bare: true, value: 'names' };
const body = z.string().describe('What you say or do. Markdown works; *asterisks* mark an action.');
const bodyHint = { positional: true, value: 'body | -' };
const observe = { observe: true } as const;
const observation = { observe: z.boolean().optional() };
const ids = z.array(activityId).optional().describe('Only these activity IDs, like ["act/12"].');
const idHint = { value: 'activity-ids', bare: true };
const pageLimit = z.number().int().min(1).max(PAGE_CAP).optional();
const duration = z.string().refine(value => parseDurationMs(value) !== undefined, 'must be a positive duration like 30s');
const listShape = {
  depth: z.number().int().min(0).max(MAX_LIST_DEPTH).optional().describe('How many directory levels to explore (default 4).'),
  limit: pageLimit.describe('How many squares per page (default 20).'),
  after: z.string().min(1).refine(value => !path.isAbsolute(value), 'must be a relative path').optional().describe('Continue after this relative square path.'),
};
const viewer = z.string().optional().describe('Whose listening to show.');
const doneBody = z.literal('').optional();
const joinShape = { takeover: z.boolean().optional().describe('Claim this name from another session.') };
const expressShape = {
  body,
  mentions: z.array(z.string()).optional().describe('Who you are speaking to. If omitted, standing @names in the body count; an empty list leaves them literal.'),
  reply: activityId.optional().describe('The activity you are answering, like act/12.'),
  force: z.boolean().optional().describe('Speak now, even if something reached you that you have not perceived yet.'),
  noWait: z.boolean().optional().describe('If you are speaking too fast, return at once instead of waiting.'),
};
const perceiveShape = {
  ids, from,
  mention: z.boolean().optional().describe('Only what was addressed to you.'),
  limit: pageLimit.describe('At most this many at once (default 10).'),
  wait: duration.optional().describe('If nothing matches, wait this long for new activity, like 30s.'),
  replace: z.boolean().optional().describe('Replace another perceive already waiting for this participant.'),
};
function checkReplace(input: { replace?: boolean; wait?: string }, issue: (field: string, message: string) => void) {
  if (input.replace !== undefined && input.wait === undefined) issue('replace', 'requires wait');
}
const bound = z.string().refine(text => parseActivityId(text) !== undefined || Number.isFinite(parseTimeOrRelative(text, 0)),
  'must be an activity ID, ISO timestamp or relative duration').optional();
const historyShape = {
  from, to: z.string().optional().describe('Only activity that reached this participant.'),
  search: z.string().min(1).refine(value => {
    const { text, mode } = historySearch(value);
    try { compileSearchPattern(text, mode === 'literal'); return true; } catch { return false; }
  }, 'must be valid search text or a /regular expression/').optional().describe('Match names, IDs or words literally, or wrap a regular expression in slashes.'),
  ids,
  after: bound.describe('Read forward after this activity ID, ISO timestamp or lookback duration.'),
  before: bound.describe('Only activity before this activity ID, ISO timestamp or lookback duration.'),
  context: z.number().int().min(0).max(PAGE_CAP).optional().describe('Activities before and after each match.'),
  limit: pageLimit.describe('Matches per page (default 10); ignored with ids.'),
  maxChars: z.number().int().min(0).optional().describe('Characters per body (default 1000).'),
};
const attentionShape = {
  target: z.string().describe('The participant to turn toward or away from.'),
  state: z.enum(['listen', 'ignore', 'neutral']).describe('Hear everything, hear nothing, or return to direct attention.'),
};
const muteShape = {
  duration: z.string().refine(value => value === 'off' || parseDurationMs(value) !== undefined,
    'must be a positive duration or off').describe('Pause for a duration like 30m, or use off to resume.'),
};
const sdkSchemas = {
  list: z.strictObject({ ...listShape, owner: z.custom<Owner>().optional(), ledgerLocation: z.string().optional(), clock: z.custom<() => number>().optional() }),
  status: z.strictObject({ viewer, ...observation }),
  done: z.strictObject({ body: doneBody, ...observation }),
  observation: z.strictObject(observation),
  join: z.strictObject({ ...joinShape, ...observation, owner: z.custom<Owner>(), wakeAddress: z.custom<WakeAddress>().optional() }),
  express: z.strictObject({ ...expressShape, body: body.optional(), metadata: z.custom<ActivityMetadata>().optional(), ...observation }),
  perceive: z.strictObject({ ...perceiveShape, ...observation }).superRefine((input, ctx) =>
    checkReplace(input, (field, message) => ctx.addIssue({ code: 'custom', path: [field], message }))),
  history: z.strictObject({ ...historyShape, ...observation }),
  attention: z.strictObject(attentionShape),
  mute: z.strictObject(muteShape),
};
type SdkInput<K extends keyof typeof sdkSchemas> = z.output<(typeof sdkSchemas)[K]>;
type ReadonlyInput<T> = { readonly [K in keyof T]: T[K] extends infer V ? V extends unknown[] ? Readonly<V> : V : never };
export type DiscoveryOptions = Readonly<SdkInput<'list'>>;
export type StatusOptions = Readonly<SdkInput<'status'>>;
export type JoinOptions = SdkInput<'join'>;
export type ExpressInput = ReadonlyInput<SdkInput<'express'>>;
export type ExpressOptions = Omit<ExpressInput, 'body'>;
export type PerceiveOptions = ReadonlyInput<SdkInput<'perceive'>>;
export type HistoryQuery = ReadonlyInput<SdkInput<'history'>>;
export type AttentionInput = SdkInput<'attention'>;
export type MuteInput = SdkInput<'mute'>;

export function parseOperation<K extends keyof typeof sdkSchemas>(operation: K, input: unknown): SdkInput<K> {
  const result = sdkSchemas[operation].safeParse(input);
  if (!result.success) {
    if (operation === 'done' && result.error.issues.some(issue => issue.path[0] === 'body'))
      throw new SquareError('invalid_args', 'done only leaves the square and does not accept a message; use express before leaving', { reason: 'invalid_done_body' });
    throw new SquareError('invalid_args', issueText(result.error));
  }
  return result.data as SdkInput<K>;
}

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
  return binding.api.Square.at({ cwd: binding.cwd, path: location, ledgerLocation: binding.ledgerLocation, clock: binding.clock }, control);
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

type ExpressionInput = Coordinates & Omit<ExpressInput, 'metadata' | 'reply'> & { metadata?: string; reply?: string };
function cliExpression(binding: OperationBinding, input: ExpressionInput, invalidReply?: string): Promise<string> {
  return binding.expressFromCli!(control => open(binding, input.location, control), input, binding.identity, binding.ownerFlag, invalidReply);
}

export function sendExpression(participant: Participant, body: string | undefined, options: ExpressOptions, control: OperationControl) {
  return participant.express(body, { ...options, ...observe }, control);
}

export const OPERATIONS: readonly Operation[] = [
  operation('list', 'Find nearby squares, including your joined names and what is waiting for them.', listShape,
  { location: false, group: 'host', aliases: ['ls'], fields: { after: { once: true, value: 'path' } } }, async (binding, options, control) => {
    let owner;
    try { owner = binding.identity().owner; }
    catch (error) { if (binding.surface !== 'cli') throw error; }
    const { cwd, ledgerLocation, clock, surface } = binding;
    const result = await binding.api.discover({ cwd }, { ...options, owner, ledgerLocation, clock }, control);
    return binding.text.list(result, { now: clock(), depth: options.depth ?? DEFAULT_LIST_DEPTH, limit: options.limit ?? DEFAULT_LIST_LIMIT, surface });
  }),
  operation('join', 'Step into the square under your name and see what was said most recently.', joinShape,
  { as: requiredParticipant }, (binding, { as, location, ...options }, control) =>
    inSquare(binding, { location }, control, async square => {
      const identity = binding.identity();
      return binding.text.join(await square.join(binding.api.requireJoinName(as), { ...identity, owner: binding.api.requireOwner(identity.owner), ...options, ...observe }, control), binding.ownerFlag, binding.surface);
    })),
  operation('express', 'Speak or act in the square. Plain words, half-formed ideas and *actions* all belong here. Said to no one in particular, your words reach those who listen to you.', expressShape,
  { as: participant, fields: { body: bodyHint, mentions: { flag: '--mention', repeat: true, value: 'name', split: name => name === '' ? [] : [name] }, reply: { value: 'activity-id' }, force: { short: '-f' }, metadata: { value: 'json' } },
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
      await sendExpression(await binding.api.selectOwnSeat(square, binding.identity().owner, as), body, options, control), binding.ownerFlag, binding.surface));
  }),
  operation('perceive', 'Take in what reached you since you last looked: mentions, replies, and words from those you listen to.', perceiveShape,
  { as: participant, fields: { ids: idHint, from: fromHint, wait: { bare: true, value: 'duration' } }, check: checkReplace,
    interrupted: (location, text) => text.perceiveStopped(location),
  }, (binding, { location, as, ...args }, control) => {
    const options = { ...args, limit: args.limit ?? PERCEIVE_DEFAULT_LIMIT };
    return inSquare(binding, { location }, control, async (square, location) => {
      const result = await (await binding.api.selectOwnSeat(square, binding.identity().owner, as)).perceive({ ...options, ...observe }, {
        ...control, onProgress(progress) {
          control.onProgress?.(progress);
          if (progress.kind === 'perceive-started' && progress.replacementRequested)
            binding.progress?.(binding.text.perceiveProgress(progress.replaced));
        },
      });
      binding.exit?.(result.reason === 'already-active' || result.reason === 'capped' ? 1 : 0);
      return binding.text.perceive(location, result, options, binding.ownerFlag, binding.surface);
    });
  }),
  operation('history', 'Look back at what was said without taking anything in.', historyShape,
  { fields: { ids: idHint, context: { short: '-C', preferShort: true }, from: { ...fromHint, bare: false },
    after: { value: 'id-or-time' }, before: { value: 'id-or-time' }, to: { value: 'name' } } },
  (binding, { location, as: _as, ...query }, control) => inSquare(binding, { location }, control, async (square, location) =>
    binding.text.history(location, await square.history({ ...query, ...observe }, control), { query, surface: binding.surface }))),
  operation('attention', 'Turn toward someone or away from them: listen, ignore, or return to neutral.', attentionShape,
  { as: participant, fields: { target: { positional: true, value: 'participant' } }, projections: [
    { name: 'listen', fixed: { state: 'listen' }, summary: "Turn an ear toward one participant's future activity." },
    { name: 'unlisten', fixed: { state: 'neutral' }, summary: "Return to direct attention from one participant." },
    { name: 'ignore', fixed: { state: 'ignore' }, summary: "Stop hearing one participant's future activity." },
  ] }, (binding, { location, as, ...input }, control) => inSquare(binding, { location }, control, async (square, location) =>
    binding.text.attention(location, input.state, await (await binding.api.selectOwnSeat(square, binding.identity().owner, as)).attention(input, observe, control)))),
  operation('done', 'Step out of the square.', {}, {
    as: participant, cliShape: { body: z.string().optional().describe('Leave with these parting words.') }, fields: { body: bodyHint },
  }, async (binding, { location, as, body }, control) => {
    if (binding.stdin && (body === '-' || (!body && !binding.stdin.tty))) body = await binding.stdin.read();
    return inSquare(binding, { location }, control, async (square, location) =>
      binding.text.done(location, await (await binding.api.selectOwnSeat(square, binding.identity().owner, as)).done(body, observe, control)));
  }),
  operation('status', 'Look around the square: who is here, the latest activity, and who you listen to.', {}, {
    as: viewer,
  }, (binding, { location, as }, control) => inSquare(binding, { location }, control, async (square, location) => {
    const viewer = (await binding.api.selectOwnSeat(square, binding.identity().owner, as, { optional: true }))?.name;
    return binding.text.status(location, await square.status({ viewer, ...observe }, control), { surface: binding.surface });
  })),
  operation('mute', 'Pause or resume automatic notifications. Whatever reaches you stays waiting for perceive.', muteShape,
  { location: 'Path to the .square file. Omit to set the hold for the entire ledger.', as: participant,
    fields: { duration: { positional: true, bare: true, value: 'duration | off' } },
    check({ location, as }, issue) { if (location === undefined && as !== undefined) issue('as', 'needs a square location for mute'); },
  }, async (binding, { location, as, duration }, control) => {
    if (location === undefined) return binding.text.mute(undefined,
      await binding.api.muteDeliveryLedger({ duration, ledgerLocation: binding.ledgerLocation, clock: binding.clock }, control));
    return inSquare(binding, { location }, control, async (square, location) => binding.text.mute(location,
      await (await binding.api.selectOwnSeat(square, binding.identity().owner, as)).mute({ duration }, observe, control)), false);
  }),
];

export function fieldFlag(field: string): string {
  return `--${field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

export function spellField(operation: string, field: string, surface: PresentationSurface = 'cli'): string {
  return surface === 'tool' ? field
    : CLI_OPERATIONS.find(cli => cli.operation.name === operation)?.fields.find(option => option.key === field)?.flag ?? fieldFlag(field);
}

export function spellAction({ operation, args, owner, help, absoluteLocation }: Suggestion, surface: PresentationSurface = 'cli'): string {
  const { location, as, ...options } = args ?? {};
  if (surface === 'tool') {
    if (help) return ''; // Tools expose their help in the schema, not as an invocation.
    const clean = { location: typeof location === 'string' && !absoluteLocation ? displayPath(location) : location, as, ...options };
    return Object.values(clean).every(value => value === undefined) ? operation : `${operation} ${JSON.stringify(clean)}`;
  }
  const cli = CLI_OPERATIONS.find(cli => (cli.operation.name === operation || cli.names.includes(operation))
    && Object.entries(cli.fixed ?? {}).every(([key, value]) => options[key] === value));
  const prefix = ['square'];
  if (typeof location === 'string') {
    const resolve = as !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location);
    prefix.push(fieldFlag('location'), quoteShell(resolve ? path.resolve(location) : location));
  }
  if (typeof as === 'string') prefix.push(fieldFlag('as'), quoteShell(as));
  if (owner !== undefined) prefix.push('--owner', quoteShell(owner));
  const flags: string[] = help ? ['--help'] : [];
  const positional: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false || Object.hasOwn(cli?.fixed ?? {}, key)) continue;
    const field = cli?.fields.find(option => option.key === key);
    const flag = (field?.preferShort ? field.short : field?.flag) ?? fieldFlag(key);
    if (value === true) { flags.push(flag); continue; }
    const values = Array.isArray(value) && field?.repeat && value.length > 0 ? value : [value];
    for (const entry of values) {
      const text = String(entry);
      const quoted = typeof entry === 'number' || text === '-' || /^(act\/\d+|\d+)$/.test(text)
        || field?.bare && /^[\p{L}\p{M}\p{N}_.,/@-]+$/u.test(text) ? text : quoteShell(text);
      const looksLikeFlag = text.startsWith('--') || text === '-h' || cli?.fields.some(option => text === option.short);
      if (field?.positional) positional.push(...looksLikeFlag ? ['--', quoted] : [quoted]);
      else flags.push(...looksLikeFlag ? [`${flag}=${quoted}`] : [flag, quoted]);
    }
  }
  const command = cli === undefined || cli.names.includes(operation) ? operation : cli.name;
  return [...prefix, command, ...flags, ...positional].join(' ');
}

export function displayPath(squarePath: string, cwd = process.cwd()): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(squarePath)) return squarePath;
  if (!path.isAbsolute(squarePath)) return squarePath.split(path.sep).join('/');
  const comparableCwd = fs.realpathSync.native(cwd);
  let comparableSquarePath = squarePath;
  try {
    comparableSquarePath = fs.realpathSync.native(squarePath);
  } catch {
    // Some error outputs name a path before it exists; lexical comparison remains useful there.
  }
  const relative = path.relative(comparableCwd, comparableSquarePath);
  return (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? relative : squarePath).split(path.sep).join('/');
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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