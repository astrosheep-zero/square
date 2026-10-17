import { z } from 'zod/v4';
import { isSquareError } from './model.js';
import type { ActivityId, ApplicationFailureDetail, ApplicationOutcome, OperationControl, SquareApplication } from './square-facade.js';

type JsonObject = Record<string, unknown>;
type Outcome = Promise<ApplicationOutcome<object, unknown, false>>;
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run(app: SquareApplication<false>, args: JsonObject, control: OperationControl): Outcome;
}

const location = z.string().optional().describe('Path to the .square artifact, relative to the current working directory. Defaults to the configured square.');
const participant = z.string().optional().describe('Participant name, same as --as. Defaults to the configured participant or the current session’s unambiguous participant.');
const activityId = z.string().regex(/^act\/(0|[1-9][0-9]*)$/) as z.ZodType<ActivityId>;
const stringArray = z.array(z.string());

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
  run: (app: SquareApplication<false>, args: z.output<z.ZodObject<S>>, control: OperationControl) => Outcome,
): ToolDefinition {
  const inputSchema = z.object({ ...shape, location }).strict();
  return { name, description, inputSchema, run: (app, args, control) => {
    const { location: _location, ...operationArgs } = inputSchema.parse(args) as JsonObject;
    return run(app, operationArgs as z.output<z.ZodObject<S>>, control);
  } };
}

export const SQUARE_TOOL_INSTRUCTIONS = 'The catch tool consumes activities. Use history with act/<index> cursors for read-only archive access.';

export const SQUARE_TOOLS: readonly ToolDefinition[] = [
  tool('join', 'Join the square as a participant.', { as: participant, takeover: z.boolean().optional().describe('Take the name from its current session owner.') },
    (app, { takeover }, control) => app.join({ takeover }, control)),
  tool('express', 'Express a message or embodied action in the square. Mentions and replies direct attention; bell reaches everyone. Bare activity is valid even with no listeners.', {
    as: participant, body: z.string(), mentions: stringArray.optional(), reach: z.enum(['bell']).optional(),
    reply: activityId.optional(), noMention: z.boolean().optional().describe('Disable body @name scanning; explicit mentions and reply still apply.'),
    force: z.boolean().optional().describe('Speak without first catching unread activity or satisfying attention etiquette.'),
    noWait: z.boolean().optional().describe('Return an error rather than waiting when held or throttled.'),
  }, (app, { body, as: _participant, ...options }, control) => app.express(body, options, control)),
  tool('catch', 'Catch and consume activities perceptible to the participant. idle waits for relevant activity or this many milliseconds of quiet; omitted means immediate. id catches one activity and cannot be combined with filters, idle or limit.', {
    as: participant, id: activityId.optional(), idle: z.number().finite().min(0).optional(), from: stringArray.optional(),
    mention: z.boolean().optional(), limit: z.number().int().min(1).optional(),
  }, (app, { as: _participant, ...options }, control) => app.catch(options, control)),
  tool('history', 'Read the activity stream without consuming it, using stable activity-id cursors. Default page size is 10, maximum 100. grep is a regex; fixed is literal text; use only one.', {
    limit: z.number().int().min(1).optional(), order: z.enum(['asc', 'desc']).optional(), before: activityId.optional(), after: activityId.optional(),
    grep: z.string().optional(), fixed: z.string().optional(), from: stringArray.optional(), mention: z.string().optional(),
  }, (app, args, control) => app.history(args, control)),
  tool('listen', 'Listen for future bare activity from a participant, clearing any ignore of them.', { as: participant, target: z.string() },
    (app, { target }, control) => app.listen(target, control)),
  tool('ignore', 'Block a participant’s future mentions and bare activity. Listening again clears the ignore; already landed activity is unchanged.', { as: participant, target: z.string() },
    (app, { target }, control) => app.ignore(target, control)),
  tool('listening', 'List participants this participant is listening to.', { as: participant },
    (app, _args, control) => app.listening(control)),
  tool('hold', 'Raise a hand to hold the square.', { as: participant, reason: z.string().optional() },
    (app, { reason }, control) => app.hold(reason, control)),
  tool('resume', 'Release the current hold.', { as: participant },
    (app, _args, control) => app.resume(control)),
  tool('done', 'Leave the square without adding a message.', { as: participant },
    (app, _args, control) => app.done(undefined, control)),
  tool('status', 'Read the public status of the square.', {},
    (app, _args, control) => app.status(undefined, control)),
  tool('participants', 'List participants standing in or done with the square.', {},
    (app, _args, control) => app.participants(control)),
];

export function squareToolFailure(error: unknown, signal?: AbortSignal): JsonObject {
  const normalized = signal?.aborted
    ? { code: 'cancelled', message: 'The Square operation was cancelled' }
    : isSquareError(error)
      ? { code: error.code, message: error.message, ...(error.facts === undefined ? {} : { facts: error.facts }) }
      : error instanceof z.ZodError
        ? { code: 'invalid_args', message: error.message }
        : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  const operation = error instanceof Error ? (error as Error & { operation?: ApplicationFailureDetail }).operation : undefined;
  return operation === undefined ? normalized : { ...normalized, operation };
}
