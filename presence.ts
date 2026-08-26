import { extractMentions, formatActivityId } from './square-core.js';
import { deliveryDelta, directedPeerSays, matchesFeedFilter } from './activity-feed.js';
import { deriveDeliveryModel, markSeenNotifications, type DeliveryModel } from './delivery.js';
import { SquareError, type StoredAct } from './model.js';
import type { OpenSquare } from './open-square.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { resolveKnownName } from './decisions.js';
import { recordObservation } from './runtime.js';
import type { CatchOptions, CatchResult, PerceivedActivity } from './square-facade.js';

function expose(squareState: import('./model.js').SquareState, activity: StoredAct, viewer: string, delivery: DeliveryModel): PerceivedActivity {
  if (activity.kind === 'read' || activity.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(activity.index)}`);
  const perception = delivery.perceive(activity, viewer);
  const result = { id: formatActivityId(activity.index), at: activity.at, kind: activity.kind, actor: activity.actor, mentions: activity.kind === 'say' ? extractMentions(activity.body) : [], ...('body' in activity && activity.body !== undefined ? { body: activity.body } : {}), ...('target' in activity ? { target: activity.target } : {}), ...(activity.kind === 'say' && activity.reply !== undefined ? { reply: formatActivityId(activity.reply) } : {}) };
  if (perception === 'full' || !('body' in result)) return { ...result, perception };
  const { body: _body, ...withoutBody } = result;
  return { ...withoutBody, perception };
}

export async function catchUp(
  square: OpenSquare,
  name: string,
  options: CatchOptions = {},
  deriveDelivery: (state: import('./model.js').SquareState) => DeliveryModel = deriveDeliveryModel,
): Promise<CatchResult> {
  const idle = options.idle ?? 0;
  if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
  const deadline = Date.now() + idle;
  while (true) {
    const attempt = await square.cell.transact((state, version) => {
      const at = square.clock();
      const viewer = resolveKnownName(state, name);
      const delivery = deriveDelivery(state);
      const delta = deliveryDelta(state, viewer, delivery);
      const filter = { ...(options.from === undefined ? {} : { participants: [...options.from] }), ...(options.mention === true ? { mention: viewer } : {}) };
      const delivered = directedPeerSays(state, delta, viewer, delivery).filter((activity) => matchesFeedFilter(
        activity,
        filter,
      ))
        .filter((activity, index, activities) => activities.findIndex((candidate) => candidate.index === activity.index) === index)
        .sort((left, right) => left.index - right.index);
      const seenChanged = delivered.length === 0 ? false : markSeenNotifications(state, viewer, delivered, at, delivery);
      const cursor = delivery.cursorFor(viewer);
      return { ...(seenChanged ? { state } : {}), result: { version, caught: { activities: delivered.map((activity) => expose(state, activity, viewer, delivery)), consumedThrough: cursor < 0 ? null : formatActivityId(cursor), idleExpired: false } satisfies CatchResult } };
    });
    if (attempt.caught.activities.length > 0 || idle === 0) return attempt.caught;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !await square.cell.changed(attempt.version, remaining)) return { ...attempt.caught, idleExpired: true };
  }
}

/** Commit seen only for complete, actually rendered boundary bodies. */
export async function markBoundarySeen(
  squarePath: string,
  name: string,
  ownerId: string | undefined,
  actIndexes: readonly number[],
  at = Date.now(),
): Promise<void> {
  let square: OpenSquare;
  try { square = await openSquare(squarePath); } catch { return; }
  try {
    await square.cell.transact((state) => {
      let changed = false;
      for (const index of actIndexes) changed = recordObservation(state, name, index, 'seen', at, ownerId) || changed;
      return changed ? { state, result: undefined } : { result: undefined };
    });
  } finally {
    await closeOpenSquare(square);
  }
}

export async function markNotificationNotified(
  square: OpenSquare,
  name: string,
  actIndex: number,
  ownerId: string | undefined,
  at = Date.now(),
): Promise<void> {
  await square.cell.transact((state) => recordObservation(state, name, actIndex, 'notified', at, ownerId)
    ? { state, result: undefined }
    : { result: undefined });
}
