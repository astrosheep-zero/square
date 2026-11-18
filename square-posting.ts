import { encodeDeliveryKey, type DeliveryKey } from './delivery-key.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DeliveryLedger, type DeliveryRoute, type DeliverySession } from './delivery-ledger.js';
import { dispatchPostedCard, isProducerDispatchRoute } from './notifications.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';
import { openReadOnlyDeliveryLedger } from './notification-mute.js';
import { projectNotification, displayAttentionPath } from './attention-presentation.js';
import type { CardPresentation } from './card-presentation.js';
import { coreDone } from './decisions.js';
import { SquareError, activityMetadataHasContent, nameKey, type Seat } from './model.js';
import type { SquareArtifactPort, SquareRead } from './ports.js';
import { formatActivityId } from './square-core.js';
import { parseSquarePostKey, squarePostKey, type SquarePost } from './square-post.js';

function requireLedgerLocation(ledgerLocation: string): void {
  if (typeof ledgerLocation !== 'string' || !path.isAbsolute(ledgerLocation)) throw new TypeError('Expected a resolved absolute delivery ledger location');
}
const openLedger = (ledgerLocation: string, clock: () => number, signal?: AbortSignal) => {
  requireLedgerLocation(ledgerLocation);
  return DeliveryLedger.open({ location: ledgerLocation, clock, signal });
};
function requireFiniteClock(clock: () => number): void {
  if (!Number.isFinite(clock())) throw new SquareError('invalid_args', 'Square time must be a finite number.');
}
function renderPost(location: string, post: SquarePost): { text: string; full: boolean } {
  if (post.kind === 'notice') return { text: post.body ?? '', full: true };
  const projected = projectNotification({ squarePath: location, actIndex: post.index, recipient: post.recipient,
    actor: post.from, route: post.route!, body: post.body ?? '',
    metadataOnly: !(post.body?.trim()) && activityMetadataHasContent(post.metadata) });
  return { text: projected.text, full: projected.isFull };
}
/** Local producer custody and current host attachment are different observations. */
export async function deliverySessionsForSeats(ledger: DeliveryLedger, seats: readonly Seat[], signal?: AbortSignal): Promise<ReadonlyMap<string, DeliverySession | undefined>> {
  const owners = [...new Set(seats.map(seat => seat.owner))];
  return new Map(await Promise.all(owners.map(async owner => [owner, await ledger.session(owner, signal)] as const)));
}
/** Read-only host observations for status; callers fence them against the captured World seats. */
export async function readSquareSessions(seats: readonly Seat[], signal: AbortSignal | undefined, ledgerLocation: string, clock: () => number = Date.now): Promise<ReadonlyMap<string, DeliverySession | undefined>> {
  requireLedgerLocation(ledgerLocation);
  requireFiniteClock(clock);
  if (!seats.length) return new Map();
  const ledger = await openReadOnlyDeliveryLedger(ledgerLocation, clock, signal);
  if (ledger === undefined) return new Map();
  try { return await deliverySessionsForSeats(ledger, seats, signal); }
  finally { await ledger.close(); }
}
/** A first producer join may register an absent owner, never resume or revive one. */
export async function ensureInitialDeliverySession(owner: Seat['owner'], route: DeliveryRoute | undefined, signal: AbortSignal | undefined, ledgerLocation: string, clock: () => number = Date.now): Promise<boolean> {
  requireFiniteClock(clock);
  const ledger = await openLedger(ledgerLocation, clock, signal);
  try {
    const current = await ledger.session(owner, signal);
    if (!current) {
      return !!await ledger.attach({ owner, expectedGeneration: null, routes: route ? [route] : [] }, signal);
    }
    if (current.state !== 'attached') return false;
    if (route) return await ledger.updateRoutes({ owner, generation: current.generation,
      routes: [...current.routes.filter(candidate => candidate.kind !== route.kind), route] }, signal);
    return true;
  } finally { await ledger.close(); }
}
/** Called only by privileged mutations. Sandbox lease/ACK/selection never enters here. */
export async function reconcileSquareDelivery(artifact: SquareArtifactPort, location: string, clock: () => number, signal: AbortSignal | undefined, ledgerLocation: string): Promise<readonly Seat[]> {
  requireLedgerLocation(ledgerLocation);
  requireFiniteClock(clock);
  const seats = (await artifact.read(currentSeats, signal)).value;
  const ledger = await openLedger(ledgerLocation, clock, signal);
  try {
    const sessions = await deliverySessionsForSeats(ledger, seats, signal);
    const awaySeats: Seat[] = [];
    for (const seat of seats) {
      const session = sessions.get(seat.owner);
      if (!session) continue;
      if (session.state === 'detached') awaySeats.push(seat);
      if (session.state === 'deleted') {
        await artifact.transactAs({ kind: 'host-cleanup', seat }, facts => {
          const current = facts.seat(seat.participant);
          if (current?.owner === seat.owner && current.generation === seat.generation && facts.participant(seat.participant)?.joined)
            facts.land(coreDone(facts, seat.participant, '', clock()));
        }, signal);
      } else if (seat.attachment !== session.state) {
        const attachment = session.state;
        await artifact.transactAs({ kind: 'producer' }, facts => facts.setSeatAttachment(seat, attachment), signal);
      }
    }
    // A full receipt is monotonic external presentation evidence, never inferred from silence.
    for (const [owner, session] of sessions) {
      if (session?.state !== 'attached') continue;
      const watermark = (await artifact.read(facts => facts.receiptWatermark(owner), signal)).value;
      const receipts = await ledger.receipts(owner, { afterSeq: watermark }, signal);
      if (!receipts.length) continue;
      const relevant = receipts.flatMap(receipt => {
        const id = parseSquarePostKey(location, receipt.key);
        return id ? [{ ...receipt, id }] : [];
      });
      const at = new Map(relevant.map(receipt => [encodeDeliveryKey(receipt.key), receipt.at]));
      await artifact.transactAs({ kind: 'producer' }, facts => {
        const posts = facts.postsAt(relevant.map(receipt => receipt.id), 'receipt');
        for (const post of posts) {
          if (post.owner === owner && post.full === true && !post.consumed && currentPost(facts, post))
            facts.foldReceipt(post, at.get(encodeDeliveryKey(squarePostKey(location, post)))!);
        }
        facts.advanceReceiptWatermark(owner, receipts[receipts.length - 1]!.seq);
      }, signal);
    }
    await suppressWithdrawn(artifact, ledger, location, signal);
    return awaySeats;
  } finally { await ledger.close(); }
}
function currentSeats(facts: SquareRead): readonly Seat[] {
  return facts.roster().filter(person => person.joined)
    .flatMap(person => { const seat = facts.seat(person.name); return seat ? [seat] : []; });
}
function currentPost(facts: SquareRead, post: SquarePost): boolean {
  const seat = facts.seat(post.recipient);
  return !!facts.participant(post.recipient)?.joined && seat?.owner === post.owner && seat.generation === post.generation;
}
async function suppressWithdrawn(artifact: SquareArtifactPort, ledger: DeliveryLedger, location: string, signal?: AbortSignal): Promise<void> {
  const snapshot = (await artifact.read(facts => ({ seats: currentSeats(facts), departed: facts.departedSeats() }), signal)).value;
  const owners = new Set([...snapshot.seats, ...snapshot.departed].map(seat => seat.owner));
  const live = (await Promise.all([...owners].map(owner => ledger.cards({ owner, keyPrefix: ['square', location] }, signal)))).flat()
    .flatMap(card => { const id = parseSquarePostKey(location, card.key); return id ? [{ ...card, id }] : []; });
  const identities = new Set(live.map(card => JSON.stringify([card.owner, card.key])));
  const posts = (await artifact.read(facts => {
    const seats = new Map(currentSeats(facts).map(seat => [nameKey(seat.participant), seat]));
    return [
      ...facts.postDispositionsAt(live.map(card => card.id)).filter(post => {
        const seat = seats.get(nameKey(post.recipient));
        return identities.has(JSON.stringify([post.owner, squarePostKey(location, post)]))
          && (post.consumed || seat?.owner !== post.owner || seat.generation !== post.generation);
      }),
      ...facts.withdrawnClaims(Date.now()),
    ];
  }, signal)).value;
  // Only existing cards or in-window claims can still require withdrawal; custody survives.
  const keysByOwner = new Map<string, Map<string, DeliveryKey>>();
  for (const post of posts) {
    const keys = keysByOwner.get(post.owner) ?? new Map<string, DeliveryKey>();
    const key = squarePostKey(location, post);
    keys.set(encodeDeliveryKey(key), key);
    keysByOwner.set(post.owner, keys);
  }
  for (const [owner, keys] of keysByOwner) await ledger.suppressExact(owner, [...keys.values()], signal);
  if (snapshot.departed.length) await artifact.transactAs({ kind: 'producer' }, facts => {
    for (const seat of snapshot.departed) facts.clearDepartedSeat(seat);
  }, signal);
}
/** One export path for Square activities and Square-owned notices. No transaction spans I/O. */
export async function flushSquarePosts(artifact: SquareArtifactPort, location: string, clock: () => number, signal: AbortSignal | undefined, ledgerLocation: string): Promise<void> {
  requireLedgerLocation(ledgerLocation);
  signal ??= AbortSignal.timeout(5000);
  // Delivery enrichment cannot turn a committed producer mutation into a retry of that mutation.
  let lifetime: ReturnType<typeof retainDeliveryLedger> | undefined;
  try {
    requireFiniteClock(clock);
    const snapshot = (await artifact.read(facts => ({
      pending: facts.pendingPosts(Date.now()).map(post => {
        const activity = post.kind === 'activity' ? facts.activity(post.index) : undefined;
        const reply = activity?.kind === 'say' ? activity.reply : undefined;
        return { post, replyTo: reply === undefined ? undefined : facts.activity(reply)?.actor };
      }),
      seats: currentSeats(facts),
    }), signal)).value;
    const ledger = await openLedger(ledgerLocation, clock, signal);
    lifetime = retainDeliveryLedger(ledger);
    const sessions = await deliverySessionsForSeats(ledger, snapshot.seats, signal);
    for (const { post, replyTo } of snapshot.pending) {
      const session = sessions.get(post.owner);
      if (session?.state !== 'attached') continue;
      const rendered = renderPost(location, post), token = randomUUID();
      const owned = (await artifact.transactAs({ kind: 'producer' }, facts =>
        facts.acquirePost({ ...post, full: rendered.full }, token, process.pid, clock()), signal)).value;
      if (!owned) continue;
      let posted = false, knownUnsent = true;
      try {
        // This check is not custody across the await; the ledger independently fences delivery.
        const current = await ledger.session(post.owner, signal);
        if (current?.state !== 'attached' || current.generation !== session.generation
          || !(await artifact.read(facts => facts.ownsPost(token), signal)).value) continue;
        knownUnsent = false;
        const result = await ledger.post({ owner: post.owner, key: squarePostKey(location, post), text: rendered.text,
          ...(post.kind === 'activity' ? { details: { kind: 'presentation', origin: displayAttentionPath(location),
            ref: formatActivityId(post.index), author: post.from, label: 'express', body: post.body ?? '',
            at: post.at, reach: post.route!, recipient: post.recipient,
            ...(replyTo === undefined ? {} : { replyTo }) } satisfies CardPresentation } : {}),
        }, signal);
        posted = ['posted', 'duplicate', 'suppressed'].includes(result.status);
        knownUnsent = !posted;
        if (result.status === 'conflict') throw new Error('A Square card key already holds different text.');
      } finally {
        const disposition = posted ? 'posted' : owned === 'initial' && knownUnsent ? 'never-exported' : 'uncertain';
        await artifact.settleAs({ kind: 'producer' }, facts => facts.settlePost(token, rendered.full, disposition));
      }
    }
    await suppressWithdrawn(artifact, ledger, location, signal);
    for (const [owner, session] of sessions) {
      if (session?.state !== 'attached' || !session.routes.some(isProducerDispatchRoute)) continue;
      const pending = (await ledger.pending(owner, { generation: session.generation }, signal))
        .flatMap(card => { const id = parseSquarePostKey(location, card.key); return id ? [id] : []; });
      const posts = (await artifact.read(facts => facts.postsAt(pending)
        .filter(post => post.owner === owner && !post.consumed && currentPost(facts, post)), signal)).value;
      for (const post of posts) await dispatchPostedCard(ledger, owner, squarePostKey(location, post), {
        signal, track: result => lifetime?.track(result), squareMention: post.kind === 'activity' && post.route === 'mention',
      });
    }
  } catch {
    // Unsettled/uncertain producer work is retried with its stable key at the next mutation.
    // Missing ledger evidence never proves that an external card was not inserted or delivered.
  } finally { await lifetime?.close(); }
}
