import { extractMentions } from './square-core.js';
import { captureRoute, parseSquareRoute, type SquareRoute } from './delivery.js';
import { sameName, SquareError } from './model.js';
import { Square } from './square-wiring.js';
import type { ExpressResult } from './square-facade.js';

export { Square } from './square-wiring.js';
export { SquareError } from './model.js';
export { captureRoute } from './delivery.js';
export type { SquareRoute } from './delivery.js';
export type { ActivityId } from './square-core.js';
export type {
  Activity,
  CatchOptions,
  CatchResult,
  ExpressOptions,
  ExpressResult,
  HistoryQuery,
  OpenOptions,
  Participant,
  ParticipantStatus,
  PerceivedActivity,
  SquareAtInput,
  SquareBuildInput,
  SquareSnapshot,
  SquareSource,
  WakeNotifier,
} from './square-facade.js';

export interface RouteExpressOptions {
  readonly as: string;
  readonly body: string;
}

function directedBody(body: string, recipient: string): string {
  if (body.trim() === '') throw new SquareError('invalid_args', 'express body cannot be empty');
  if (extractMentions(body).some((mention) => sameName(mention, recipient))) return body;
  return `${body}${/\s$/u.test(body) ? '' : ' '}@${recipient}`;
}

export async function express(route: SquareRoute, options: RouteExpressOptions): Promise<ExpressResult> {
  const parsed = parseSquareRoute(route);
  if (
    options === null || typeof options !== 'object' ||
    typeof options.as !== 'string' || options.as.trim() === '' ||
    typeof options.body !== 'string'
  ) {
    throw new SquareError('invalid_args', 'Route express requires { as, body }');
  }
  const square = await Square.at({ path: parsed.squarePath });
  try {
    const recipient = (await square.participants()).find(
      (participant) => participant.state === 'joined' && sameName(participant.name, parsed.name)
    );
    if (recipient === undefined) throw new SquareError('invalid_args', `Unknown participant "${parsed.name}"`);
    const sender = await square.join(options.as);
    return sender.express(directedBody(options.body, recipient.name));
  } finally {
    await square.close();
  }
}
