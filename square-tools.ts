import { z } from 'zod/v4';
import { isSquareError } from './model.js';
import { CATCH_DEFAULT_LIMIT, type Square } from './square-api.js';
import type {
  ActivityId, ActivityMetadata, CatchOptions, CatchResult, ExpressResult, HistoryQuery, HistoryResult, JoinResult,
  LifecycleResult, ListenerChangeResult, ListeningResult, OperationControl, OperationFailureDetail,
  ParticipantsResult, StatusResult,
} from './square-facade.js';
import {
  renderCatchOutcome, renderExpression, renderFailureLines, renderHistoryResult, renderJoinResult,
  renderLifecycleResult, renderListenerChange, renderListeningResult, renderParticipantsResult,
  renderStatusResult, type FailureReport, type JoinPresentation,
} from './operation-presentation.js';

type JsonObject = Record<string, unknown>;
type Outcome = Promise<object>;
type ToolRender = (result: JsonObject, args: JsonObject) => string | undefined;
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run(square: Square, args: JsonObject, control: ToolControl): Outcome;
  /** Human text identical to what the CLI prints; transports show this to people. */
  render: ToolRender;
}

/** A transport that shows people the square asks the same operation for its rendering facts. */
export interface ToolControl extends OperationControl {
  readonly observe?: boolean;
}

const location = z.string().optional().describe('Local .square artifact path or configured backend URI (stdio://name/key). Relative paths use the current working directory. Defaults to the configured square.');
const participant = z.string().optional().describe('Participant name. Defaults to the configured participant or the current session’s unambiguous participant.');
const activityId = z.string().regex(/^act\/(0|[1-9][0-9]*)$/) as z.ZodType<ActivityId>;
const stringArray = z.array(z.string());

/** Keep the observation request internal: it is not an argument a caller decides. */
function observation(control: ToolControl): { observe?: true } {
  return control.observe === true ? { observe: true } : {};
}

/** Tool receipts are plain JSON; each renderer re-declares the facts it reads. */
function rendering<T>(render: (result: T, args: JsonObject) => string | undefined): ToolRender {
  return (result, args) => render(result as unknown as T, args);
}

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
  run: (square: Square, args: z.output<z.ZodObject<S>>, control: ToolControl) => Outcome,
  render: ToolRender,
): ToolDefinition {
  const inputSchema = z.object({ ...shape, location }).strict();
  return { name, description, inputSchema, render, run: (square, args, control) => {
    const { location: _location, ...operationArgs } = inputSchema.parse(args) as JsonObject;
    return run(square, operationArgs as z.output<z.ZodObject<S>>, control);
  } };
}

export const SQUARE_TOOL_INSTRUCTIONS = 'The catch tool consumes activities. Use history with act/<index> cursors for read-only archive access.';

export const SQUARE_TOOLS: readonly ToolDefinition[] = [
  tool('join', 'Join the square as a participant.', { as: participant, takeover: z.boolean().optional().describe('Take the name from its current session owner.') },
    async (square, { as, takeover }, control) => {
      const { participant, ...receipt } = await square.join(as, { takeover, ...observation(control) }, control);
      return { ...receipt, participant: participant.name };
    },
    rendering((result: JoinPresentation) => renderJoinResult(result))),
  tool('express', 'Express a message, structured metadata, or embodied action in the square. Mentions and replies direct attention; bell reaches everyone and keeps body @names literal. Bell cannot combine with explicit mentions. Bare activity is valid even with no listeners.', {
    as: participant, body: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(), mentions: stringArray.optional(), reach: z.enum(['bell']).optional(),
    reply: activityId.optional(), noMention: z.boolean().optional().describe('Disable body @name scanning; explicit mentions and reply still apply.'),
    force: z.boolean().optional().describe('Speak without first catching unread activity or satisfying attention etiquette.'),
    noWait: z.boolean().optional().describe('Return an error rather than waiting when held or throttled.'),
  }, async (square, { body, metadata, as, ...options }, control) => {
    const { delivery: _delivery, ...result } = await (await square.participant(as)).express({ body, metadata: metadata as ActivityMetadata, ...options, ...observation(control) }, control);
    return result;
  }, rendering((result: ExpressResult) => renderExpression(result.observation?.location ?? '', result))),
  tool('catch', 'Catch and consume activities perceptible to the participant. idle waits for relevant activity or this many milliseconds of quiet; omitted means immediate. id catches one activity and cannot be combined with filters, idle or limit.', {
    as: participant, id: activityId.optional(), idle: z.number().finite().min(0).optional(), from: stringArray.optional(),
    mention: z.boolean().optional(), limit: z.number().int().min(1).optional(),
  }, async (square, { as, ...options }, control) => (await square.participant(as)).catch({ ...options, ...observation(control) }, control),
    rendering((result: CatchResult, args) => {
      // The CLI always spells the default cap in its continuation, so the tool does too.
      const options = args as CatchOptions;
      const renderOptions = options.id === undefined ? { ...options, limit: options.limit ?? CATCH_DEFAULT_LIMIT } : options;
      return renderCatchOutcome(result.observation?.location ?? '', result, renderOptions).stdout;
    })),
  tool('history', 'Read the activity stream without consuming it, using stable activity-id cursors. Default page size is 10, maximum 100. grep is a regex; fixed is literal text; use only one.', {
    limit: z.number().int().min(1).optional(), order: z.enum(['asc', 'desc']).optional(), before: activityId.optional(), after: activityId.optional(),
    grep: z.string().optional(), fixed: z.string().optional(), from: stringArray.optional(), mention: z.string().optional(),
  }, (square, args, control) => square.history({ ...args, ...observation(control) }, control),
    rendering((result: HistoryResult, args) => renderHistoryResult(result.observation?.location ?? '', result, { query: args as HistoryQuery }))),
  tool('listen', 'Listen for future activity from a participant, clearing any ignore of them.', { as: participant, target: z.string() },
    async (square, { as, target }, control) => (await square.participant(as)).listen(target, observation(control), control),
    rendering((result: ListenerChangeResult) => renderListenerChange(result.observation?.location ?? '', 'listen', result))),
  tool('ignore', 'Block a participant’s future mentions and bare activity. Listening again clears the ignore; already landed activity is unchanged.', { as: participant, target: z.string() },
    async (square, { as, target }, control) => (await square.participant(as)).ignore(target, observation(control), control),
    rendering((result: ListenerChangeResult) => renderListenerChange(result.observation?.location ?? '', 'ignore', result))),
  tool('unlisten', 'Stop listening to a participant’s future activity; mentions and replies still reach you. An existing ignore is unchanged.', { as: participant, target: z.string() },
    async (square, { as, target }, control) => (await square.participant(as)).unlisten(target, observation(control), control),
    rendering((result: ListenerChangeResult) => renderListenerChange(result.observation?.location ?? '', 'unlisten', result))),
  tool('listening', 'List participants this participant is listening to.', { as: participant },
    async (square, { as }, control) => (await square.participant(as)).listening(observation(control), control),
    rendering((result: ListeningResult) => renderListeningResult(result.observation?.location ?? '', result))),
  tool('hold', 'Raise a hand to hold the square.', { as: participant, reason: z.string().optional() },
    async (square, { as, reason }, control) => (await square.participant(as)).hold(reason, observation(control), control),
    rendering((result: LifecycleResult) => renderLifecycleResult(result.observation?.location ?? '', 'hold', result))),
  tool('resume', 'Release the current hold.', { as: participant },
    async (square, { as }, control) => (await square.participant(as)).resume(observation(control), control),
    rendering((result: LifecycleResult) => renderLifecycleResult(result.observation?.location ?? '', 'resume', result))),
  tool('done', 'Leave the square without adding a message.', { as: participant },
    async (square, { as }, control) => (await square.participant(as)).done(undefined, observation(control), control),
    rendering((result: LifecycleResult) => renderLifecycleResult(result.observation?.location ?? '', 'done', result))),
  tool('status', 'Read the public status of the square.', {},
    (square, _args, control) => square.status(observation(control), control),
    rendering((result: StatusResult) => renderStatusResult(result.observation?.location ?? '', result))),
  tool('participants', 'List participants standing in or done with the square.', {},
    (square, _args, control) => square.participants(observation(control), control),
    rendering((result: ParticipantsResult) => renderParticipantsResult(result.observation?.location ?? '', result))),
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
