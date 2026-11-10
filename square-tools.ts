import { z } from 'zod/v4';
import { isSquareError, SquareError } from './model.js';
import { requireOwner, requireJoinName, selectOwnSeat, HISTORY_MAX_LIMIT, PERCEIVE_MAX_LIMIT, PERCEIVE_DEFAULT_LIMIT, DEFAULT_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_DEPTH, MAX_LIST_LIMIT, type Square } from './square-api.js';
import { parseDurationMs, parseTimeOrRelative } from './time.js';
import type {
  Owner, WakeAddress, ActivityId, PerceiveOptions, PerceiveResult, ExpressResult, HistoryQuery, HistoryResult,
  LifecycleResult, ListenerChangeResult, OperationControl, OperationFailureDetail, StatusResult, DiscoveryOptions, DiscoveryResult,
} from './square-facade.js';
import {
  renderPerceiveOutcome, renderExpression, renderFailureLines, renderHistoryResult, renderJoinResult, type ListenerVerb,
  renderLifecycleResult, renderListenerChange, renderStatusResult, renderSquareList,
  type FailureReport, type JoinPresentation,
} from './operation-presentation.js';

export interface ToolIdentity { readonly owner?: Owner; readonly wakeAddress?: WakeAddress }
type JsonObject = Record<string, unknown>;

interface ToolBinding {
  identity: ToolIdentity;
  readonly now?: () => number;
  open(location: string | undefined, control: OperationControl): Promise<Square>;
  discover(options: DiscoveryOptions, control: OperationControl): Promise<DiscoveryResult>;
}

export function createSquareToolRunner() {
  return async (tool: ToolDefinition, args: JsonObject, control: OperationControl,
    bind: () => Promise<ToolBinding> | ToolBinding,
  ): Promise<{ text: string; isError?: true }> => {
    let square: Square | undefined;
    try {
      const binding = await bind();
      if ('runDiscovery' in tool) return { text: await tool.runDiscovery(args, control, binding) };
      square = await binding.open(args.location as string | undefined, control);
      try {
        return { text: await tool.run(square, args, control, binding.identity, binding.now) };
      } finally { await square.close(); }
    } catch (error) {
      return { isError: true, text: squareToolFailureText(squareToolFailure(error, control.signal), {
        location: square?.location ?? (args.location as string | undefined),
        participant: typeof args.as === 'string' ? args.as : undefined,
      }) };
    }
  };
}

type Outcome = Promise<object>;
type ToolRender = (result: JsonObject, args: JsonObject) => string | undefined;
interface SingleSquareToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Human text identical to what the CLI prints; domain receipts stay inside the adapter. */
  run(square: Square, args: JsonObject, control: OperationControl, identity: ToolIdentity, now?: () => number): Promise<string>;
}

interface DiscoveryToolDefinition {
  name: 'list';
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  runDiscovery(args: JsonObject, control: OperationControl, binding: ToolBinding): Promise<string>;
}
type ToolDefinition = SingleSquareToolDefinition | DiscoveryToolDefinition;

const location = z.string().describe('Path to the .square file, relative to the working directory.');
const participant = z.string().optional().describe('Your name in the square. Leave it out if you hold exactly one name here.');
const activityId = z.string().regex(/^act\/(0|[1-9][0-9]*)$/) as z.ZodType<ActivityId>;
const stringArray = z.array(z.string());

/** Each renderer declares the operation facts it reads. */
function rendering<T>(render: (result: T, args: JsonObject) => string | undefined): ToolRender {
  return (result, args) => render(result as unknown as T, args);
}

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
  run: (square: Square, args: z.output<z.ZodObject<S>>, control: OperationControl, identity: ToolIdentity, now?: () => number) => Outcome,
  render: ToolRender,
): SingleSquareToolDefinition {
  const inputSchema = z.object({ ...shape, location }).strict();
  return { name, description, inputSchema,
    run: async (square, args, control, identity, now) => {
      const { location: _location, ...operationArgs } = inputSchema.parse(args) as JsonObject;
      const receipt = await run(square, operationArgs as z.output<z.ZodObject<S>>, control, identity, now);
      return render(receipt as JsonObject, operationArgs) ?? '';
    } };
}

export function squareToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SQUARE_TOOLS?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false' || raw === 'none') return false;
  throw new SquareError('invalid_args', 'Invalid SQUARE_TOOLS: expected 0, 1, true, false, or none.');
}

export const SQUARE_TOOL_INSTRUCTIONS = 'List nearby squares and your joined names with list. Pass location for a single square. Join once. Then express to speak, and perceive to take in what reached you. History looks back without taking anything in.';

type HistoryToolQuery = Omit<HistoryQuery, 'search' | 'cursor' | 'since'> & {
  readonly search?: string; readonly regex?: boolean;
  readonly before?: ActivityId; readonly after?: ActivityId;
  readonly since?: string; readonly full?: boolean;
};
function historyToolQuery({ search, regex, before, after, since, full: _full, ...query }: HistoryToolQuery, now = Date.now()): HistoryQuery {
  if (before !== undefined && after !== undefined) throw new SquareError('invalid_args', 'Use before or after, not both.');
  const sinceMs = since === undefined ? undefined : parseTimeOrRelative(since, now);
  if (sinceMs !== undefined && !Number.isFinite(sinceMs)) throw new SquareError('invalid_args', `Invalid since timestamp: ${since}`);
  return { ...query,
    ...(sinceMs === undefined ? {} : { since: sinceMs }),
    search: search === undefined ? undefined : { text: search, mode: regex ? 'regex' : 'literal' },
    cursor: after !== undefined ? { id: after, direction: 'after' } : before === undefined ? undefined : { id: before, direction: 'before' },
  };
}

const target = z.string().describe('The participant to turn toward or away from.');

const listSchema = z.object({
  depth: z.number().int().min(0).max(MAX_LIST_DEPTH).optional().describe('How many directory levels to explore (default 4).'),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe('How many squares per page (default 20).'),
  after: z.string().min(1).optional().describe('Continue after this relative square path.'),
}).strict();

export const SQUARE_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'list', description: 'Find nearby squares, including your joined names and what is waiting for them. Start here to choose a location.',
    inputSchema: listSchema,
    async runDiscovery(args, control, binding) {
      const options = listSchema.parse(args);
      const result = await binding.discover({ ...options, owner: binding.identity.owner }, control);
      return renderSquareList(result, { now: (binding.now ?? Date.now)(), depth: options.depth ?? DEFAULT_LIST_DEPTH, limit: options.limit ?? DEFAULT_LIST_LIMIT, surface: 'tool' });
    },
  },
  tool('join', 'Step into the square under your name. Do this once before you speak or perceive. You arrive seeing what was said most recently.', {
    as: z.string().describe('Your name in the square.'),
    takeover: z.boolean().optional().describe('Claim this name even though another session holds it now. That session loses it.'),
    last: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe('How many recent public activities to show on arrival (default 10).'),
  }, (square, { as, takeover, last }, control, identity) => square.join(requireJoinName(as), { ...identity, owner: requireOwner(identity.owner), takeover, last, observe: true }, control),
    rendering((result: JoinPresentation) => renderJoinResult(result, undefined, 'tool'))),
  tool('express', 'Speak or act in the square. Plain words, half-formed ideas and *actions* all belong here. Mention or reply to someone to be heard by them; ring the bell to be heard by everyone. Said to no one in particular, your words reach those who listen to you.', {
    as: participant,
    body: z.string().describe('What you say or do. Markdown works; *asterisks* mark an action.'),
    mentions: stringArray.optional().describe('Who you are speaking to. An @name in the body that matches someone here counts too.'),
    bell: z.boolean().optional().describe('Call everyone in the square. Not with mentions.'),
    reply: activityId.optional().describe('The activity you are answering, like act/12. Its author hears you if still here.'),
    noMention: z.boolean().optional().describe('Leave @names in the body as plain text. Mentions and reply still reach people.'),
    force: z.boolean().optional().describe('Speak now, even if something reached you that you have not perceived yet.'),
    noWait: z.boolean().optional().describe('If you are speaking too fast, return at once instead of waiting.'),
  }, async (square, { body, bell, as, ...options }, control, identity) =>
    (await selectOwnSeat(square, identity.owner, as)).express(body, { ...options, ...(bell ? { reach: 'bell' } : {}), observe: true }, control),
    rendering((result: ExpressResult) => renderExpression(result.observation?.location ?? '', result, undefined, 'tool'))),
  tool('perceive', 'Take in what reached you since you last looked: mentions, replies, bells, and words from those you listen to. What you perceive no longer waits for you; history lets you look back.', {
    as: participant,
    id: activityId.optional().describe('Open this one activity in full, like act/12. Use it alone.'),
    idle: z.string().optional().describe('When nothing is waiting, wait for activity or this much quiet, like "30s". Leave it out to return at once.'),
    from: stringArray.optional().describe('Only what these participants said.'),
    mention: z.boolean().optional().describe('Only what was addressed to you, and bells.'),
    limit: z.number().int().min(1).max(PERCEIVE_MAX_LIMIT).optional().describe('At most this many at once (default 10). The rest keeps waiting.'),
    takeover: z.boolean().optional().describe('Take over from another active idle perceive for this participant.'),
  }, async (square, { as, idle, ...args }, control, identity) => {
    const options: PerceiveOptions = { ...args, ...(idle === undefined ? {} : { idle: parseDurationMs(idle, 'idle') }) };
    return { ...(await (await selectOwnSeat(square, identity.owner, as)).perceive({ ...options, observe: true }, control)), options };
  },
    rendering((result: PerceiveResult & { options: PerceiveOptions }) => {
      // The CLI always spells the default cap in its continuation, so the tool does too.
      const options = result.options;
      const renderOptions = options.id === undefined ? { ...options, limit: options.limit ?? PERCEIVE_DEFAULT_LIMIT } : options;
      return renderPerceiveOutcome(result.observation?.location ?? '', result, renderOptions, undefined, 'tool').stdout;
    })),
  tool('history', 'Look back at what was said. Reading here takes nothing in: whatever waits for perceive keeps waiting. Page with before or after.', {
    limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe('How many per page (default 10).'),
    order: z.enum(['asc', 'desc']).optional().describe('"asc" for oldest first (default), "desc" for newest first.'),
    before: activityId.optional().describe('The page just before this activity, like act/12.'),
    after: activityId.optional().describe('The page just after this activity, like act/12.'),
    at: z.array(activityId).min(1).optional().describe('Center on these activity ids, like ["act/12"].'),
    context: z.number().int().min(0).max(HISTORY_MAX_LIMIT).optional().describe('Activities of context before and after each "at" activity.'),
    since: z.string().optional().describe('Only activities after this ISO timestamp or relative duration (like "10m").'),
    search: z.string().optional().describe('Only activities containing this text in their names, ids or words.'),
    regex: z.boolean().optional().describe('Treat search as a regular expression.'),
    from: stringArray.optional().describe('Only what these participants said.'),
    mention: z.string().optional().describe('Only what was addressed to this participant.'),
    full: z.boolean().optional().describe('Show full activity bodies even when multiple activities are returned.'),
  }, async (square, args, control, _identity, now) => {
    const query = historyToolQuery(args, now?.());
    return { ...(await square.history({ ...query, observe: true }, control)), query };
  },
    rendering((result: HistoryResult & { query: HistoryQuery }, args) => renderHistoryResult(result.observation?.location ?? '', result, { query: result.query, full: args.full === true, surface: 'tool' }))),
  tool('attention', 'Turn toward someone or away from them, from now on. Listen: hear everything they say, even to others. Unlisten: stop listening without clearing an ignore; mentions and replies still reach you unless ignored. Ignore: hear nothing from them but bells. What was already said stays as it was.', {
    as: participant, action: z.enum(['listen', 'unlisten', 'ignore']).describe('"listen", "unlisten" or "ignore". Listening again ends an ignore.'), target,
  }, async (square, { as, action, target }, control, identity) =>
    (await selectOwnSeat(square, identity.owner, as))[action](target, { observe: true }, control),
  rendering((result: ListenerChangeResult, args) => renderListenerChange(result.observation?.location ?? '', args.action as ListenerVerb, result))),
  tool('done', 'Step out of the square. Everyone sees you leave, and you stop listening to anyone. Leaving carries no words, so say goodbye with express first. Stay instead if someone may still need you; you can join again later.', { as: participant },
    async (square, { as }, control, identity) => (await selectOwnSeat(square, identity.owner, as)).done(undefined, { observe: true }, control),
    rendering((result: LifecycleResult) => renderLifecycleResult(result.observation?.location ?? '', result))),
  tool('status', 'Look around the square: who is here, the latest activity, and who you listen to.', {
    as: z.string().optional().describe('Whose listening to show. Leave it out if you hold exactly one name here.'),
  }, async (square, { as }, control, identity) => {
    const viewer = (await selectOwnSeat(square, identity.owner, as, { optional: true }))?.name;
    return square.status({ viewer, observe: true }, control);
  }, rendering((result: StatusResult) => renderStatusResult(result.observation?.location ?? '', result, { surface: 'tool' }))),
];

export function squareToolFailure(error: unknown, signal?: AbortSignal): JsonObject {
  const normalized = signal?.aborted
    ? { code: 'cancelled', message: 'The Square operation was cancelled' }
    : isSquareError(error)
      ? { code: error.code, message: error.message, ...(error.facts === undefined ? {} : { facts: error.facts }) }
      : error instanceof z.ZodError
        ? { code: 'invalid_args', message: error.message }
        : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  const operation = error instanceof Error ? (error as Error & { operation?: OperationFailureDetail }).operation : undefined;
  return operation === undefined ? normalized : { ...normalized, operation };
}

/** Readable failure text with tool-native recovery actions, never raw JSON. */
export function squareToolFailureText(failure: JsonObject, context: { location?: string; participant?: string } = {}): string {
  return renderFailureLines(failure as unknown as FailureReport, { squarePath: context.location, name: context.participant, surface: 'tool' }).join('\n');
}
