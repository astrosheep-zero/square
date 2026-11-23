import path from 'node:path';
import { z } from 'zod/v4';
import { parseActivityId, PAGE_CAP, ACTIVITY_ID_PATTERN, MAX_LIST_DEPTH, type ActivityId } from './square-core.js';
import { parseDurationMs, parseTimeOrRelative } from './time.js';
import { compileSearchPattern, historySearch } from './search.js';
import { SquareError, type ActivityMetadata, type Owner, type WakeAddress } from './model.js';

export const location = z.string().describe('Path to the .square file.');
export const requiredParticipant = z.string().describe('Your name in the square.');
export const participant = requiredParticipant.optional().describe(requiredParticipant.description!);
const activityId = z.string().regex(ACTIVITY_ID_PATTERN, { error: 'must be an activity id like act/12', abort: true })
  .refine(id => parseActivityId(id) !== undefined, 'must be a representable activity id') as z.ZodType<ActivityId>;
const from = z.array(z.string()).optional().describe('Only what these participants said.');
export const body = z.string().describe('What you say or do. Markdown works; *asterisks* mark an action.');
const ids = z.array(activityId).optional().describe('Only these activity IDs, like ["act/12"].');
const pageLimit = z.number().int().min(1).max(PAGE_CAP).optional();
const duration = z.string().refine(value => parseDurationMs(value) !== undefined, 'must be a positive duration like 30s');
export const listShape = {
  depth: z.number().int().min(0).max(MAX_LIST_DEPTH).optional().describe('How many directory levels to explore (default 4).'),
  limit: pageLimit.describe('How many squares per page (default 20).'),
  after: z.string().min(1).refine(value => !path.isAbsolute(value), 'must be a relative path').optional().describe('Continue after this relative square path.'),
};
export const viewer = z.string().optional().describe('Whose listening to show.');
const doneBody = z.literal('').optional();
export const joinShape = { takeover: z.boolean().optional().describe('Claim this name from another session.') };
export const expressShape = {
  body,
  mentions: z.array(z.string()).optional().describe('Who you are speaking to. If omitted, standing @names in the body count; an empty list leaves them literal.'),
  reply: activityId.optional().describe('The activity you are answering, like act/12.'),
  force: z.boolean().optional().describe('Speak now, even if something reached you that you have not perceived yet.'),
  noWait: z.boolean().optional().describe('If you are speaking too fast, return at once instead of waiting.'),
};
export const perceiveShape = {
  ids, from,
  mention: z.boolean().optional().describe('Only what was addressed to you.'),
  limit: pageLimit.describe('At most this many at once (default 10).'),
  wait: duration.optional().describe('If nothing matches, wait this long for new activity, like 30s.'),
  replace: z.boolean().optional().describe('Replace another perceive already waiting for this participant.'),
};
export function checkReplace(input: { replace?: boolean; wait?: string }, issue: (field: string, message: string) => void) {
  if (input.replace !== undefined && input.wait === undefined) issue('replace', 'requires wait');
}
const bound = z.string().refine(text => parseActivityId(text) !== undefined || Number.isFinite(parseTimeOrRelative(text, 0)),
  'must be an activity ID, ISO timestamp or relative duration').optional();
export const historyShape = {
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
export const attentionShape = {
  target: z.string().describe('The participant to turn toward or away from.'),
  state: z.enum(['listen', 'ignore', 'neutral']).describe('Hear everything, hear nothing, or return to direct attention.'),
};
export const muteShape = {
  duration: z.string().refine(value => value === 'off' || parseDurationMs(value) !== undefined,
    'must be a positive duration or off').describe('Pause for a duration like 30m, or use off to resume.'),
};
const sdkSchemas = {
  list: z.strictObject({ ...listShape, owner: z.custom<Owner>().optional(), ledgerLocation: z.string().optional(), clock: z.custom<() => number>().optional() }),
  status: z.strictObject({ viewer }),
  done: z.strictObject({ body: doneBody }),
  join: z.strictObject({ ...joinShape, owner: z.custom<Owner>(), wakeAddress: z.custom<WakeAddress>().optional() }),
  express: z.strictObject({ ...expressShape, body: body.optional(), metadata: z.custom<ActivityMetadata>().optional() }),
  perceive: z.strictObject(perceiveShape).superRefine((input, ctx) =>
    checkReplace(input, (field, message) => ctx.addIssue({ code: 'custom', path: [field], message }))),
  history: z.strictObject(historyShape),
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

export function toolInvocation(operation: string, args: Record<string, unknown>): string {
  return Object.values(args).every(value => value === undefined) ? operation : `${operation} ${JSON.stringify(args)}`;
}
