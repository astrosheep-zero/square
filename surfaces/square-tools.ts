import { z } from 'zod/v4';
import { renderHistoryResult } from './history-presentation.js';
import { renderPerceiveOutcome } from './perceive-presentation.js';
import { isSquareError, SquareError } from '../core/model.js';
import { ACTIVITY_ID_PATTERN, requireOwner, requireJoinName, selectOwnSeat, HISTORY_MAX_LIMIT, PERCEIVE_MAX_LIMIT, PERCEIVE_DEFAULT_LIMIT, DEFAULT_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_DEPTH, MAX_LIST_LIMIT, discover, muteDeliveryLedger, unmuteDeliveryLedger, Square } from '../api/square-api.js';
import { parseDurationMs, parseTimeOrRelative } from '../core/time.js';
import type {
  Owner, WakeAddress, ActivityId, PerceiveOptions, HistoryQuery,
  OperationControl, OperationFailureDetail,
} from '../api/types.js';
import {
  renderExpression, renderFailureLines, renderJoinResult, type ListenerVerb,
  renderLifecycleResult, renderListenerChange, renderMuteResult, renderStatusResult, renderSquareList,
  type FailureReport,
} from './operation-presentation.js';

export interface ToolIdentity { readonly owner?: Owner; readonly wakeAddress?: WakeAddress }
type JsonObject = Record<string, unknown>;

interface ToolBinding {
  identity: ToolIdentity;
  cwd?: string;
  ledgerLocation: string;
  clock: () => number;
}

type WithSquare = (location: string | undefined, work: (square: Square) => Promise<string>, useOpenedLocation?: boolean) => Promise<string>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** One typed resource operation rendered in the same handler. */
  run(args: JsonObject, control: OperationControl, binding: ToolBinding, withSquare: WithSquare): Promise<string>;
}

function failureReport(error: unknown, signal?: AbortSignal): FailureReport {
  const normalized: FailureReport = signal?.aborted
    ? { code: 'cancelled', message: 'The Square operation was cancelled' }
    : isSquareError(error)
      ? { code: error.code, message: error.message, ...(error.facts === undefined ? {} : { facts: error.facts }) }
      : error instanceof z.ZodError
        ? { code: 'invalid_args', message: error.message }
        : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  const operation = error instanceof Error ? (error as Error & { operation?: OperationFailureDetail }).operation : undefined;
  return operation === undefined ? normalized : { ...normalized, operation };
}

export async function runSquareTool(tool: ToolDefinition, args: JsonObject, control: OperationControl,
  bind: () => Promise<ToolBinding> | ToolBinding,
): Promise<{ text: string; isError?: true }> {
  let failureLocation = typeof args.location === 'string' ? args.location : undefined;
  try {
    const binding = await bind();
    const withSquare: WithSquare = async (location, work, useOpenedLocation = true) => {
      const square = await Square.at({ cwd: binding.cwd, path: location, ledgerLocation: binding.ledgerLocation, clock: binding.clock }, control);
      if (useOpenedLocation) failureLocation = square.location;
      try { return await work(square); } finally { await square.close(); }
    };
    return { text: await tool.run(args, control, binding, withSquare) };
  } catch (error) {
    return { isError: true, text: renderFailureLines(failureReport(error, control.signal), {
      squarePath: failureLocation,
      name: typeof args.as === 'string' ? args.as : undefined,
      surface: 'tool',
    }).join('\n') };
  }
}

const location = z.string().describe('Path to the .square file.');
const participant = z.string().optional().describe('Your name in the square.');
const activityId = z.string().regex(ACTIVITY_ID_PATTERN) as z.ZodType<ActivityId>;
const stringArray = z.array(z.string());

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
  run: (square: Square, args: z.output<z.ZodObject<S>>, control: OperationControl, binding: ToolBinding) => Promise<string | undefined>,
): ToolDefinition {
  const inputSchema = z.object({ ...shape, location }).strict();
  return { name, description, inputSchema,
    run(args, control, binding, withSquare) {
      return withSquare(typeof args.location === 'string' ? args.location : undefined, async (square) => {
        const parsed = inputSchema.parse(args) as { location: string } & z.output<z.ZodObject<S>>;
        const { location: _location, ...operationArgs } = parsed;
        return await run(square, operationArgs as z.output<z.ZodObject<S>>, control, binding) ?? '';
      });
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
const muteSchema = z.object({
  duration: z.string().describe('How long to pause automatic notifications, like "30m" or "2h".'),
  location: z.string().optional().describe('Path to the .square file. Omit to mute the entire ledger.'),
  as: z.string().optional().describe('Your name in the square.'),
}).strict();
const unmuteSchema = z.object({
  location: z.string().optional().describe('Path to the .square file. Omit to unmute the entire ledger.'),
  as: z.string().optional().describe('Your name in the square.'),
}).strict();

const listSchema = z.object({
  depth: z.number().int().min(0).max(MAX_LIST_DEPTH).optional().describe('How many directory levels to explore (default 4).'),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe('How many squares per page (default 20).'),
  after: z.string().min(1).optional().describe('Continue after this relative square path.'),
}).strict();

function muteTool(verb: 'mute' | 'unmute'): ToolDefinition {
  const inputSchema = verb === 'mute' ? muteSchema : unmuteSchema;
  return {
    name: verb,
    description: verb === 'mute'
      ? 'Step back from notifications for a while. Whatever reaches you stays waiting for perceive.'
      : 'Resume automatic notifications early.',
    inputSchema,
    async run(args, control, binding, withSquare) {
      const input = inputSchema.parse(args) as z.output<typeof muteSchema> | z.output<typeof unmuteSchema>;
      const durationMs = 'duration' in input ? parseDurationMs(input.duration, 'duration') : undefined;
      if (input.location === undefined) {
        if (input.as !== undefined) throw new SquareError('invalid_args', `A ledger-wide ${verb} does not accept as.`);
        return renderMuteResult(undefined, verb, verb === 'mute'
          ? await muteDeliveryLedger({ durationMs: durationMs!, ledgerLocation: binding.ledgerLocation, clock: binding.clock }, control)
          : await unmuteDeliveryLedger({ ledgerLocation: binding.ledgerLocation, clock: binding.clock }, control));
      }
      return withSquare(input.location, async (square) => {
        const seat = await selectOwnSeat(square, binding.identity.owner, input.as);
        return renderMuteResult(square.location, verb, verb === 'mute'
          ? await seat.mute({ durationMs: durationMs! }, { observe: true }, control)
          : await seat.unmute({ observe: true }, control));
      }, false);
    },
  };
}

export const SQUARE_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'list', description: 'Find nearby squares, including your joined names and what is waiting for them.',
    inputSchema: listSchema,
    async run(args, control, binding) {
      const options = listSchema.parse(args);
      const result = await discover({ cwd: binding.cwd },
        { ...options, owner: binding.identity.owner, ledgerLocation: binding.ledgerLocation, clock: binding.clock }, control);
      return renderSquareList(result, { now: binding.clock(), depth: options.depth ?? DEFAULT_LIST_DEPTH, limit: options.limit ?? DEFAULT_LIST_LIMIT, surface: 'tool' });
    },
  },
  tool('join', 'Step into the square under your name and see what was said most recently.', {
    as: z.string().describe('Your name in the square.'),
    takeover: z.boolean().optional().describe('Claim this name from another session.'),
    last: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe('How many recent public activities to show on arrival (default 10).'),
  }, async (square, { as, takeover, last }, control, binding) =>
    renderJoinResult(await square.join(requireJoinName(as), { ...binding.identity, owner: requireOwner(binding.identity.owner), takeover, last, observe: true }, control), undefined, 'tool')),
  tool('express', 'Speak or act in the square. Plain words, half-formed ideas and *actions* all belong here. Said to no one in particular, your words reach those who listen to you.', {
    as: participant,
    body: z.string().describe('What you say or do. Markdown works; *asterisks* mark an action.'),
    mentions: stringArray.optional().describe('Who you are speaking to. An @name in the body that matches someone here counts too.'),
    reply: activityId.optional().describe('The activity you are answering, like act/12.'),
    noMention: z.boolean().optional().describe('Leave @names in the body as plain text.'),
    force: z.boolean().optional().describe('Speak now, even if something reached you that you have not perceived yet.'),
    noWait: z.boolean().optional().describe('If you are speaking too fast, return at once instead of waiting.'),
  }, async (square, { body, as, ...options }, control, binding) =>
    renderExpression(square.location, await (await selectOwnSeat(square, binding.identity.owner, as)).express(body, { ...options, observe: true }, control), undefined, 'tool')),
  tool('perceive', 'Take in what reached you since you last looked: mentions, replies, and words from those you listen to.', {
    as: participant,
    id: activityId.optional().describe('Open this one activity in full, like act/12.'),
    wait: z.string().optional().describe('If nothing is waiting, block until something arrives or this much time passes, like "30s".'),
    from: stringArray.optional().describe('Only what these participants said.'),
    mention: z.boolean().optional().describe('Only what was addressed to you.'),
    limit: z.number().int().min(1).max(PERCEIVE_MAX_LIMIT).optional().describe('At most this many at once (default 10).'),
    takeover: z.boolean().optional().describe('Take over from another active idle perceive for this participant.'),
  }, async (square, { as, wait, ...args }, control, binding) => {
    const options: PerceiveOptions = { ...args, ...(wait === undefined ? {} : { wait: parseDurationMs(wait, 'wait') }) };
    const result = await (await selectOwnSeat(square, binding.identity.owner, as)).perceive({ ...options, observe: true }, control);
    // The CLI always spells the default cap in its continuation, so the tool does too; an exact id keeps its own coordinates.
    const renderOptions = options.id === undefined ? { ...options, limit: options.limit ?? PERCEIVE_DEFAULT_LIMIT } : options;
    return renderPerceiveOutcome(square.location, result, renderOptions, undefined, 'tool');
  }),
  tool('history', 'Look back at what was said without taking anything in.', {
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
  }, async (square, args, control, binding) => {
    const query = historyToolQuery(args, binding.clock());
    return renderHistoryResult(square.location, await square.history({ ...query, observe: true }, control),
      { query, full: args.full === true, surface: 'tool' });
  }),
  tool('attention', 'Turn toward someone or away from them. Listen: hear everything they say, even to others. Unlisten: stop listening to them. Ignore: stop hearing their future activity.', {
    as: participant, action: z.enum(['listen', 'unlisten', 'ignore']).describe('"listen", "unlisten" or "ignore".'), target,
  }, async (square, { as, action, target }, control, binding) =>
    renderListenerChange(square.location, action as ListenerVerb,
      await (await selectOwnSeat(square, binding.identity.owner, as))[action](target, { observe: true }, control))),
  tool('done', 'Step out of the square.', { as: participant },
    async (square, { as }, control, binding) =>
      renderLifecycleResult(square.location, await (await selectOwnSeat(square, binding.identity.owner, as)).done(undefined, { observe: true }, control))),
  tool('status', 'Look around the square: who is here, the latest activity, and who you listen to.', {
    as: z.string().optional().describe('Whose listening to show.'),
  }, async (square, { as }, control, binding) => {
    const viewer = (await selectOwnSeat(square, binding.identity.owner, as, { optional: true }))?.name;
    return renderStatusResult(square.location, await square.status({ viewer, observe: true }, control), { surface: 'tool' });
  }),
  muteTool('mute'),
  muteTool('unmute'),
];
