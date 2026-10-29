import { z } from 'zod/v4';
import { isSquareError, type Body, type WakeAddress } from './model.js';
import { requireBody, requireJoinName, selectOwnSeat, CATCH_DEFAULT_LIMIT, type Square } from './square-api.js';
import type {
  ActivityId, CatchOptions, CatchResult, ExpressResult, HistoryQuery, HistoryResult,
  LifecycleResult, ListenerChangeResult, OperationControl, OperationFailureDetail, StatusResult,
} from './square-facade.js';
import {
  renderCatchOutcome, renderExpression, renderFailureLines, renderHistoryResult, renderJoinResult,
  renderLifecycleResult, renderListenerChange, renderStatusResult,
  type FailureReport, type JoinPresentation, type ListenerVerb,
} from './operation-presentation.js';

export interface ToolIdentity { readonly body?: Body; readonly wakeAddress?: WakeAddress }
type JsonObject = Record<string, unknown>;
type Outcome = Promise<object>;
type ToolRender = (result: JsonObject, args: JsonObject) => string | undefined;
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Human text identical to what the CLI prints; domain receipts stay inside the adapter. */
  run(square: Square, args: JsonObject, control: OperationControl, identity: ToolIdentity): Promise<string>;
}

const location = z.string().optional().describe('Which square: a .square file path. Relative paths start from the working directory. Leave it out for the configured square.');
const participant = z.string().optional().describe('Your name in the square. Leave it out if you hold exactly one name here.');
const activityId = z.string().regex(/^act\/(0|[1-9][0-9]*)$/) as z.ZodType<ActivityId>;
const stringArray = z.array(z.string());

/** Each renderer declares the operation facts it reads. */
function rendering<T>(render: (result: T, args: JsonObject) => string | undefined): ToolRender {
  return (result, args) => render(result as unknown as T, args);
}

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
  run: (square: Square, args: z.output<z.ZodObject<S>>, control: OperationControl, identity: ToolIdentity) => Outcome,
  render: ToolRender,
): ToolDefinition {
  const inputSchema = z.object({ ...shape, location }).strict();
  return { name, description, inputSchema,
    run: async (square, args, control, identity) => {
      const { location: _location, ...operationArgs } = inputSchema.parse(args) as JsonObject;
      const receipt = await run(square, operationArgs as z.output<z.ZodObject<S>>, control, identity);
      return render(receipt as JsonObject, operationArgs) ?? '';
    } };
}

export const SQUARE_TOOL_INSTRUCTIONS = 'Join once. Then express to speak, and catch to take in what reached you. History looks back without taking anything in.';

const target = z.string().describe('The participant to turn toward or away from.');

export const SQUARE_TOOLS: readonly ToolDefinition[] = [
  tool('join', 'Step into the square under your name. Do this once before you speak or catch. You arrive seeing what was said most recently.', {
    as: z.string().optional().describe('Your name in the square. Give it explicitly when joining.'), takeover: z.boolean().optional().describe('Claim this name even though another session holds it now. That session loses it.'),
  }, (square, { as, takeover }, control, identity) => square.join(requireJoinName(as), { ...identity, body: requireBody(identity.body), takeover, observe: true }, control),
    rendering((result: JoinPresentation) => renderJoinResult(result))),
  tool('express', 'Speak or act in the square. Plain words, half-formed ideas and *actions* all belong here. Mention or reply to someone to be heard by them; ring the bell to be heard by everyone. Said to no one in particular, your words reach those who listen to you.', {
    as: participant,
    body: z.string().describe('What you say or do. Markdown works; *asterisks* mark an action.'),
    mentions: stringArray.optional().describe('Who you are speaking to. An @name in the body that matches someone here counts too.'),
    reach: z.enum(['bell']).optional().describe('"bell" calls everyone in the square. Cannot be used with mentions.'),
    reply: activityId.optional().describe('The activity you are answering, like act/12. Its author hears you if still here.'),
    noMention: z.boolean().optional().describe('Leave @names in the body as plain text. Mentions and reply still reach people.'),
    force: z.boolean().optional().describe('Speak now, even if something reached you that you have not caught yet.'),
    noWait: z.boolean().optional().describe('If a hand is raised or you are speaking too fast, return at once instead of waiting.'),
  }, async (square, { body, as, ...options }, control, identity) =>
    (await selectOwnSeat(square, identity.body, as)).express(body, { ...options, observe: true }, control),
    rendering((result: ExpressResult) => renderExpression(result.observation?.location ?? '', result))),
  tool('catch', 'Take in what reached you since you last looked: mentions, replies, bells, and words from those you listen to. What you catch no longer waits for you; history lets you look back.', {
    as: participant,
    id: activityId.optional().describe('Take in this activity in full, like act/12, even if you caught it before. Do not combine with idle, from, mention or limit.'),
    idle: z.number().finite().min(0).optional().describe('When nothing is waiting, wait until something arrives or until it has been quiet this many milliseconds. Leave it out to return at once.'),
    from: stringArray.optional().describe('Only what these participants said.'),
    mention: z.boolean().optional().describe('Only what was addressed to you, and bells.'),
    limit: z.number().int().min(1).optional().describe('At most this many at once (default 10, up to 100). The rest keeps waiting.'),
  }, async (square, { as, ...options }, control, identity) => (await selectOwnSeat(square, identity.body, as)).catch({ ...options, observe: true }, control),
    rendering((result: CatchResult, args) => {
      // The CLI always spells the default cap in its continuation, so the tool does too.
      const options = args as CatchOptions;
      const renderOptions = options.id === undefined ? { ...options, limit: options.limit ?? CATCH_DEFAULT_LIMIT } : options;
      return renderCatchOutcome(result.observation?.location ?? '', result, renderOptions).stdout;
    })),
  tool('history', 'Look back at what was said. Reading here takes nothing in: whatever waits for catch keeps waiting. Page with before or after.', {
    limit: z.number().int().min(1).optional().describe('How many per page (default 10, up to 100).'),
    order: z.enum(['asc', 'desc']).optional().describe('"asc" for oldest first (default), "desc" for newest first.'),
    before: activityId.optional().describe('The page just before this activity, like act/12.'),
    after: activityId.optional().describe('The page just after this activity, like act/12.'),
    grep: z.string().optional().describe('Only activities matching this regular expression in their names, ids or words. Use grep or fixed, not both.'),
    fixed: z.string().optional().describe('Only activities containing this exact text.'),
    from: stringArray.optional().describe('Only what these participants said.'),
    mention: z.string().optional().describe('Only what was addressed to this participant.'),
  }, (square, args, control) => square.history({ ...args, observe: true }, control),
    rendering((result: HistoryResult, args) => renderHistoryResult(result.observation?.location ?? '', result, { query: args as HistoryQuery }))),
  tool('attention', 'Turn toward someone or away from them, from now on. Listen: hear everything they say, even to others. Unlisten: stop listening without clearing an ignore; mentions and replies still reach you unless ignored. Ignore: hear nothing from them but bells. What was already said stays as it was.', {
    as: participant, action: z.enum(['listen', 'unlisten', 'ignore']).describe('"listen", "unlisten" or "ignore". Listening again ends an ignore.'), target,
  }, async (square, { as, action, target }, control, identity) => {
    const self = await selectOwnSeat(square, identity.body, as);
    return self[action](target, { observe: true }, control);
  }, rendering((result: ListenerChangeResult, args) => renderListenerChange(result.observation?.location ?? '', args.action as ListenerVerb, result))),
  tool('hold', 'Raise a hand to pause the conversation; lower it with release. While a hand is up, new words wait to land.', {
    as: participant,
    reason: z.string().optional().describe('Why you are pausing. Everyone sees it.'),
    release: z.boolean().optional().describe('true lowers the raised hand so the conversation goes on.'),
  }, async (square, { as, reason, release }, control, identity) => {
    const self = await selectOwnSeat(square, identity.body, as);
    return release === true ? self.resume({ observe: true }, control) : self.hold(reason, { observe: true }, control);
  }, rendering((result: LifecycleResult, args) => renderLifecycleResult(result.observation?.location ?? '', args.release === true ? 'resume' : 'hold', result))),
  tool('done', 'Step out of the square. Everyone sees you leave, and you stop listening to anyone. Leaving carries no words, so say goodbye with express first. Stay instead if someone may still need you; you can join again later.', { as: participant },
    async (square, { as }, control, identity) => (await selectOwnSeat(square, identity.body, as)).done(undefined, { observe: true }, control),
    rendering((result: LifecycleResult) => renderLifecycleResult(result.observation?.location ?? '', 'done', result))),
  tool('status', 'Look around the square: who is here, whether a hand is raised, the latest activity, and who you listen to.', {
    as: z.string().optional().describe('Whose listening to show. Leave it out if you hold exactly one name here.'),
  }, async (square, { as }, control, identity) => {
    const viewer = (await selectOwnSeat(square, identity.body, as, { optional: true }))?.name;
    return square.status({ viewer, observe: true }, control);
  }, rendering((result: StatusResult) => renderStatusResult(result.observation?.location ?? '', result))),
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

/** Readable failure text with the same recovery commands the CLI offers, never raw JSON. */
export function squareToolFailureText(failure: JsonObject, context: { location?: string; participant?: string } = {}): string {
  return renderFailureLines(failure as unknown as FailureReport, { squarePath: context.location, name: context.participant }).join('\n');
}
