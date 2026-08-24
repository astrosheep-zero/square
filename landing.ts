import { extractMentions, formatActivityId, parseActivityId, type Act, type ActivityId } from './square-core.js';
import { coreDone, coreHold, coreResume, decideAct, decideImplicitJoin, decideJoin } from './decisions.js';
import { deriveDeliveryModel } from './delivery.js';
import { SquareError, type SquareState, type StoredAct } from './model.js';
import { participantIdentity } from './participant-identity.js';
import type { OpenSquare } from './open-square.js';
import type { Activity, ExpressOptions, ExpressResult } from './square-facade.js';

function storeActs(state: SquareState, acts: readonly Act[]): StoredAct[] {
  const stored: StoredAct[] = [];
  for (const act of acts) {
    const item = { ...act, index: state.runtime.nextActIndex } as StoredAct;
    state.runtime.nextActIndex += 1;
    state.acts.push(item);
    stored.push(item);
  }
  return stored;
}

function committedActivity(stored: readonly StoredAct[], verb: string): StoredAct {
  const activity = stored[0];
  if (activity === undefined) throw new Error(`${verb} activity did not commit`);
  return activity;
}

function exposeActivity(stored: StoredAct): Activity {
  if (stored.kind === 'read' || stored.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(stored.index)}`);
  return {
    id: formatActivityId(stored.index), at: stored.at, kind: stored.kind, actor: stored.actor,
    ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}),
    mentions: stored.kind === 'say' ? extractMentions(stored.body) : [],
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}),
  };
}

function parseRequiredActivityId(id: ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

async function wakeAfterCommit(square: OpenSquare, recipients: readonly string[], activity: Activity): Promise<void> {
  if (recipients.length === 0) return;
  try { square.notifier?.wake(recipients, activity); } catch { /* post-commit effects cannot undo activities */ }
}

export async function join(square: OpenSquare, name: string): Promise<{ readonly name: string; readonly activity: Activity | null }> {
  const now = square.clock();
  const committed = await square.cell.transact<{ name: string; stored: StoredAct | null }>((state) => {
    const decision = decideJoin(state, name, now);
    if (decision.joinAct === undefined) return { result: { name: decision.joinedName, stored: null } };
    return { state, result: { name: decision.joinedName, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  });
  return { name: committed.name, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

/** Automatic presence distinguishes first entry, current presence, and completed presence. */
export async function implicitJoin(square: OpenSquare, name: string): Promise<{ readonly name: string; readonly state: 'joined' | 'active' | 'done'; readonly activity: Activity | null }> {
  const now = square.clock();
  const committed = await square.cell.transact<{ name: string; state: 'joined' | 'active' | 'done'; stored: StoredAct | null }>((state) => {
    const decision = decideImplicitJoin(state, name, now);
    if (decision.joinAct === undefined) return { result: { name: decision.joinedName, state: decision.state, stored: null } };
    return { state, result: { name: decision.joinedName, state: decision.state, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  });
  return { name: committed.name, state: committed.state, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

export async function express(square: OpenSquare, name: string, body: string, options: ExpressOptions = {}): Promise<ExpressResult> {
  const now = square.clock();
  const reply = options.reply === undefined ? undefined : parseRequiredActivityId(options.reply);
  const committed = await square.cell.transact((state) => {
    const decision = decideAct(state, { name, body, force: options.force ?? false, now, ...(options.reach === undefined ? {} : { reach: options.reach }), ...(reply === undefined ? {} : { reply }) });
    if (decision.type === 'blocked') {
      const pending = decision.activitySummaries.reduce((count, summary) => count + summary.count, 0) + decision.unreadRoomChanges.length;
      throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { pending });
    }
    if (decision.type === 'held') {
      const holder = state.acts.filter((activity) => activity.kind === 'hold').at(-1)?.actor;
      throw new SquareError('held', 'The square is held', holder === undefined ? undefined : { holder });
    }
    if (decision.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`);
    if (decision.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: decision.delayMs });
    if (decision.type === 'bell_quota') throw new SquareError('bell_quota', `${participantIdentity(name)} cannot ring the bell yet`, { retryAfterMs: Math.max(1, decision.nextAt - now) });
    const stored = committedActivity(storeActs(state, [decision.act]), 'express');
    return { state, result: { stored, recipients: deriveDeliveryModel(state).plan(stored).map((notification) => notification.recipient) } };
  });
  const activity = exposeActivity(committed.stored);
  await wakeAfterCommit(square, committed.recipients, activity);
  return { activity };
}

async function landCore(square: OpenSquare, verb: 'done' | 'hold' | 'resume', actor: string, body = ''): Promise<ExpressResult> {
  const now = square.clock();
  const stored = await square.cell.transact((state) => {
    const act = verb === 'done' ? coreDone(state, actor, body, now) : verb === 'hold' ? coreHold(state, actor, body, now) : coreResume(state, actor, now);
    return { state, result: committedActivity(storeActs(state, [act]), verb) };
  });
  return { activity: exposeActivity(stored) };
}

export function done(square: OpenSquare, name: string, body = ''): Promise<ExpressResult> { return landCore(square, 'done', name, body); }
export function hold(square: OpenSquare, name: string, reason = ''): Promise<ExpressResult> { return landCore(square, 'hold', name, reason); }
export function resume(square: OpenSquare, name: string): Promise<ExpressResult> { return landCore(square, 'resume', name); }
