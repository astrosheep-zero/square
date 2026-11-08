import crypto from 'node:crypto';
import { z } from 'zod/v4';
import { isSquareError, SquareError } from './model.js';
import { requireOwner, requireJoinName, selectOwnSeat, HISTORY_MAX_LIMIT, PERCEIVE_DEFAULT_LIMIT, DEFAULT_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_DEPTH, MAX_LIST_LIMIT, type Square } from './square-api.js';
import { parseTimeOrRelative } from './time.js';
import type {
  Owner, WakeAddress, ActivityId, PerceiveOptions, PerceiveResult, ExpressResult, HistoryQuery, HistoryResult,
  LifecycleResult, ListenerChangeResult, OperationControl, OperationFailureDetail, StatusResult, DiscoveryOptions, DiscoveryResult,
} from './square-facade.js';
import {
  renderPerceiveOutcome, renderExpression, renderFailureLines, renderHistoryResult, renderJoinResult,
  renderLifecycleResult, renderListenerChange, renderStatusResult, renderSquareList,
  type FailureReport, type JoinPresentation, type ListenerVerb,
} from './operation-presentation.js';

export interface ToolIdentity { readonly owner?: Owner; readonly wakeAddress?: WakeAddress }
type JsonObject = Record<string, unknown>;

interface ExpressDraft {
  readonly owner?: Owner;
  readonly args: JsonObject;
  readonly expiresAt: number;
}

/** Process-local recovery: FIFO 64, fixed two-hour TTL, consumed only by a successful express. */
const EXPRESS_DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const EXPRESS_DRAFT_LIMIT = 64;

export class SquareExpressDrafts {
  private readonly drafts = new Map<string, ExpressDraft>();

  private purgeExpired(): void {
    const now = Date.now();
    for (const [token, draft] of this.drafts) if (draft.expiresAt <= now) this.drafts.delete(token);
  }

  resolve(args: JsonObject, owner?: Owner): { args: JsonObject; token?: string } {
    if (args.draft === undefined) return { args };
    this.purgeExpired();
    if (typeof args.draft !== 'string' || Object.keys(args).length !== 1)
      throw new SquareError('invalid_args', 'An express draft token cannot be combined with other arguments.');
    const draft = this.drafts.get(args.draft);
    if (draft === undefined || draft.owner !== owner)
      throw new SquareError('invalid_args', 'Unknown, expired, or inaccessible express draft.');
    return { args: draft.args, token: args.draft };
  }

  consume(token?: string): void {
    if (token !== undefined) this.drafts.delete(token);
  }

  retain(args: JsonObject, owner: Owner | undefined, token: string | undefined, failure: JsonObject, expressAttempted: boolean): string | undefined {
    const effect = (failure.operation as { expressEffect?: string } | undefined)?.expressEffect;
    // After an attempt, only an admission or argument refusal proves that retrying cannot duplicate an activity.
    const unsent = !expressAttempted || effect === 'unsent' || (effect === undefined && failure.code === 'invalid_args');
    if (!unsent || effect === 'landed' || effect === 'unknown' || typeof args.body !== 'string' || args.draft !== undefined
      || typeof args.location !== 'string' || !args.location.trim()) return undefined;
    this.purgeExpired();
    if (token !== undefined && this.drafts.has(token)) return token;
    const created = `dr_${crypto.randomBytes(16).toString('base64url')}`;
    this.drafts.set(created, { owner, args, expiresAt: Date.now() + EXPRESS_DRAFT_TTL_MS });
    if (this.drafts.size > EXPRESS_DRAFT_LIMIT) this.drafts.delete(this.drafts.keys().next().value!);
    return created;
  }
}
interface ToolBinding {
  identity: ToolIdentity;
  readonly now?: () => number;
  open(location: string | undefined, control: OperationControl): Promise<Square>;
  discover(options: DiscoveryOptions, control: OperationControl): Promise<DiscoveryResult>;
}

export function createSquareToolRunner() {
  const drafts = new SquareExpressDrafts();
  return async (tool: ToolDefinition, args: JsonObject, control: OperationControl,
    bind: () => Promise<ToolBinding> | ToolBinding,
  ): Promise<{ text: string; isError?: true }> => {
    let toolArgs = args;
    let owner: Owner | undefined;
    let token: string | undefined;
    let attempted = false;
    let square: Square | undefined;
    try {
      const binding = await bind();
      owner = binding.identity.owner;
      if ('runDiscovery' in tool) return { text: await tool.runDiscovery(toolArgs, control, binding) };
      if (tool.name === 'express') {
        const resolved = drafts.resolve(toolArgs, owner);
        toolArgs = resolved.args;
        token = resolved.token;
      }
      square = await binding.open(toolArgs.location as string | undefined, control);
      let text: string;
      try {
        attempted = tool.name === 'express';
        text = await tool.run(square, toolArgs, control, binding.identity, binding.now);
        drafts.consume(token);
      } finally { await square.close(); }
      return { text };
    } catch (error) {
      const failure = squareToolFailure(error, control.signal);
      const draft = tool.name === 'express' ? drafts.retain(toolArgs, owner, token, failure, attempted) : undefined;
      return { isError: true, text: squareToolFailureText(failure, {
        location: square?.location ?? (toolArgs.location as string | undefined),
        participant: typeof toolArgs.as === 'string' ? toolArgs.as : undefined,
        draft,
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

const location = z.string().describe('Which square: a .square file path. Relative paths start from the working directory.');
const expressLocation = z.string().optional().describe('Which square: a .square file path. Relative paths start from the working directory. Required unless retrying with a draft token.');
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
  const inputSchema = z.object({ ...shape, location: name === 'express' ? expressLocation : location }).strict();
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
  readonly grep?: string; readonly fixed?: string;
  readonly before?: ActivityId; readonly after?: ActivityId;
  readonly since?: string; readonly context?: number; readonly noTruncate?: boolean;
};
function historyToolQuery({ grep, fixed, before, after, since, context, contextBefore, contextAfter, noTruncate: _noTruncate, ...query }: HistoryToolQuery, now = Date.now()): HistoryQuery {
  if (grep !== undefined && fixed !== undefined) throw new SquareError('invalid_args', 'Use grep or fixed, not both.');
  if (before !== undefined && after !== undefined) throw new SquareError('invalid_args', 'Use before or after, not both.');
  const sinceMs = since === undefined ? undefined : parseTimeOrRelative(since, now);
  if (sinceMs !== undefined && !Number.isFinite(sinceMs)) throw new SquareError('invalid_args', `Invalid since timestamp: ${since}`);
  const resolvedBefore = contextBefore ?? context;
  const resolvedAfter = contextAfter ?? context;
  return { ...query,
    ...(sinceMs === undefined ? {} : { since: sinceMs }),
    ...(resolvedBefore === undefined ? {} : { contextBefore: resolvedBefore }),
    ...(resolvedAfter === undefined ? {} : { contextAfter: resolvedAfter }),
    search: grep !== undefined ? { text: grep, mode: 'regex' } : fixed === undefined ? undefined : { text: fixed, mode: 'literal' },
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
    as: z.string().optional().describe('Your name in the square. Give it explicitly when joining.'),
    takeover: z.boolean().optional().describe('Claim this name even though another session holds it now. That session loses it.'),
    last: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe('How many recent public activities to show on arrival (default 10, up to 100).'),
  }, (square, { as, takeover, last }, control, identity) => square.join(requireJoinName(as), { ...identity, owner: requireOwner(identity.owner), takeover, last, observe: true }, control),
    rendering((result: JoinPresentation) => renderJoinResult(result, undefined, 'tool'))),
  tool('express', 'Speak or act in the square. Plain words, half-formed ideas and *actions* all belong here. Mention or reply to someone to be heard by them; ring the bell to be heard by everyone. Said to no one in particular, your words reach those who listen to you.', {
    as: participant,
    body: z.string().optional().describe('What you say or do. Markdown works; *asterisks* mark an action. Required unless retrying with a draft token.'),
    draft: z.string().optional().describe('Retry a failed express kept in this process. Pass only the token; the original body and options are restored.'),
    mentions: stringArray.optional().describe('Who you are speaking to. An @name in the body that matches someone here counts too.'),
    reach: z.enum(['bell']).optional().describe('"bell" calls everyone in the square. Cannot be used with mentions.'),
    reply: activityId.optional().describe('The activity you are answering, like act/12. Its author hears you if still here.'),
    noMention: z.boolean().optional().describe('Leave @names in the body as plain text. Mentions and reply still reach people.'),
    force: z.boolean().optional().describe('Speak now, even if something reached you that you have not perceived yet.'),
    noWait: z.boolean().optional().describe('If you are speaking too fast, return at once instead of waiting.'),
  }, async (square, { body, draft, as, ...options }, control, identity) => {
    if (draft !== undefined) throw new SquareError('invalid_args', 'Unknown or expired express draft.');
    if (body === undefined) throw new SquareError('invalid_args', 'Express needs a body or a draft token.');
    return (await selectOwnSeat(square, identity.owner, as)).express(body, { ...options, observe: true }, control);
  },
    rendering((result: ExpressResult) => renderExpression(result.observation?.location ?? '', result, undefined, 'tool'))),
  tool('perceive', 'Take in what reached you since you last looked: mentions, replies, bells, and words from those you listen to. What you perceive no longer waits for you; history lets you look back.', {
    as: participant,
    id: activityId.optional().describe('Take in this activity in full, like act/12, even if you perceived it before. Do not combine with idle, from, mention, limit or takeover.'),
    idle: z.number().finite().min(0).optional().describe('When nothing is waiting, wait until something arrives or until it has been quiet this many milliseconds. Leave it out to return at once.'),
    from: stringArray.optional().describe('Only what these participants said.'),
    mention: z.boolean().optional().describe('Only what was addressed to you, and bells.'),
    limit: z.number().int().min(1).optional().describe('At most this many at once (default 10, up to 100). The rest keeps waiting.'),
    takeover: z.boolean().optional().describe('Take over from another active idle perceive for this participant.'),
  }, async (square, { as, ...options }, control, identity) => (await selectOwnSeat(square, identity.owner, as)).perceive({ ...options, observe: true }, control),
    rendering((result: PerceiveResult, args) => {
      // The CLI always spells the default cap in its continuation, so the tool does too.
      const options = args as PerceiveOptions;
      const renderOptions = options.id === undefined ? { ...options, limit: options.limit ?? PERCEIVE_DEFAULT_LIMIT } : options;
      return renderPerceiveOutcome(result.observation?.location ?? '', result, renderOptions, undefined, 'tool').stdout;
    })),
  tool('history', 'Look back at what was said. Reading here takes nothing in: whatever waits for perceive keeps waiting. Page with before or after.', {
    limit: z.number().int().min(1).optional().describe('How many per page (default 10, up to 100).'),
    order: z.enum(['asc', 'desc']).optional().describe('"asc" for oldest first (default), "desc" for newest first.'),
    before: activityId.optional().describe('The page just before this activity, like act/12.'),
    after: activityId.optional().describe('The page just after this activity, like act/12.'),
    at: z.array(activityId).min(1).optional().describe('Center on these activity ids, like ["act/12"].'),
    context: z.number().int().min(0).optional().describe('Activities of context before and after each "at" activity.'),
    contextBefore: z.number().int().min(0).optional().describe('Activities of context before each "at" activity.'),
    contextAfter: z.number().int().min(0).optional().describe('Activities of context after each "at" activity.'),
    since: z.string().optional().describe('Only activities after this ISO timestamp or relative duration (like "10m").'),
    grep: z.string().optional().describe('Only activities matching this regular expression in their names, ids or words. Use grep or fixed, not both.'),
    fixed: z.string().optional().describe('Only activities containing this exact text.'),
    from: stringArray.optional().describe('Only what these participants said.'),
    mention: z.string().optional().describe('Only what was addressed to this participant.'),
    noTruncate: z.boolean().optional().describe('Show full activity bodies even when multiple activities are returned.'),
  }, async (square, args, control, _identity, now) => {
    const query = historyToolQuery(args, now?.());
    return { ...(await square.history({ ...query, observe: true }, control)), query };
  },
    rendering((result: HistoryResult & { query: HistoryQuery }, args) => renderHistoryResult(result.observation?.location ?? '', result, { query: result.query, noTruncate: args.noTruncate === true, surface: 'tool' }))),
  tool('attention', 'Turn toward someone or away from them, from now on. Listen: hear everything they say, even to others. Unlisten: stop listening without clearing an ignore; mentions and replies still reach you unless ignored. Ignore: hear nothing from them but bells. What was already said stays as it was.', {
    as: participant, action: z.enum(['listen', 'unlisten', 'ignore']).describe('"listen", "unlisten" or "ignore". Listening again ends an ignore.'), target,
  }, async (square, { as, action, target }, control, identity) => {
    const self = await selectOwnSeat(square, identity.owner, as);
    return self[action](target, { observe: true }, control);
  }, rendering((result: ListenerChangeResult, args) => renderListenerChange(result.observation?.location ?? '', args.action as ListenerVerb, result))),
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
export function squareToolFailureText(failure: JsonObject, context: { location?: string; participant?: string; draft?: string } = {}): string {
  const report = failure as unknown as FailureReport;
  const lines = renderFailureLines(report, { squarePath: context.location, name: context.participant, surface: 'tool' });
  if (context.draft !== undefined) {
    lines.push(`· draft kept in memory: ${context.draft}`);
    lines.push(report.code === 'behind'
      ? '· perceive the pending activity, then retry express with only:'
      : '· correct the problem above, then retry express with only:', `{ "draft": "${context.draft}" }`);
  }
  return lines.join('\n');
}
