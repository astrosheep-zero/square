import { randomUUID } from 'node:crypto';
import { DeliveryLedger, type DeliveryRoute, type DeliverySession } from './delivery-ledger.js';
import { dispatchPostedCard } from './notifications.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';
import { projectNotification, displayAttentionPath } from './attention-presentation.js';
import type { CardPresentation } from './card-presentation.js';
import { coreDone } from './decisions.js';
import { activityMetadataHasContent, type Seat } from './model.js';
import type { SquareArtifactPort } from './ports.js';
import { formatActivityId } from './square-core.js';
import { squarePostKey, type SquarePost } from './square-post.js';

const openLedger = (ledgerLocation?: string, signal?: AbortSignal) => DeliveryLedger.open({ location: ledgerLocation, signal });
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
export async function readSquareSessions(seats: readonly Seat[], signal?: AbortSignal, ledgerLocation?: string): Promise<ReadonlyMap<string, DeliverySession | undefined>> {
  if (!seats.length) return new Map();
  const ledger = await openLedger(ledgerLocation, signal);
  try { return await deliverySessionsForSeats(ledger, seats, signal); }
  finally { await ledger.close(); }
}
/** A first producer join may register an absent owner, never resume or revive one. */
export async function ensureInitialDeliverySession(owner: Seat['owner'], route?: DeliveryRoute, signal?: AbortSignal, ledgerLocation?: string): Promise<boolean> {
  const ledger = await openLedger(ledgerLocation, signal);
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
export async function reconcileSquareDelivery(artifact: SquareArtifactPort, location: string, clock: () => number, signal?: AbortSignal, ledgerLocation?: string): Promise<void> {
  const snapshot = (await artifact.read(facts => ({ seats: facts.roster().filter(person => person.joined)
    .flatMap(person => { const seat = facts.seat(person.name); return seat ? [seat] : []; }), posts: facts.postedPosts() }), signal)).value;
  if (!snapshot.seats.length && !snapshot.posts.length) return;
  const ledger = await openLedger(ledgerLocation, signal);
  try {
    const sessions = await deliverySessionsForSeats(ledger, snapshot.seats, signal);
    for (const seat of snapshot.seats) {
      const session = sessions.get(seat.owner);
      if (!session) continue;
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
    const receipts = new Map<string, ReadonlyMap<string, number>>();
    for (const owner of new Set(snapshot.posts.map(post => post.owner))) {
      const keys = snapshot.posts.filter(post => post.owner === owner).map(post => squarePostKey(location, post));
      receipts.set(owner, new Map((await ledger.receipts(owner, { keys }, signal)).map(receipt => [receipt.key, receipt.at])));
    }
    for (const post of snapshot.posts) {
      const cardKey = squarePostKey(location, post);
      const receipt = receipts.get(post.owner)?.get(cardKey);
      if (receipt !== undefined && post.full === true && !post.consumed)
        await artifact.transactAs({ kind: 'producer' }, facts => facts.foldReceipt(post, receipt), signal);
    }
    await suppressWithdrawn(artifact, ledger, location, signal);
  } finally { await ledger.close(); }
}
async function suppressWithdrawn(artifact: SquareArtifactPort, ledger: DeliveryLedger, location: string, signal?: AbortSignal): Promise<void> {
  const posts = (await artifact.read(facts => facts.postedPosts().filter(post => {
    const seat = facts.seat(post.recipient);
    return post.consumed || !seat || seat.owner !== post.owner || seat.generation !== post.generation;
  }), signal)).value;
  // Departure withdraws only the captured notification, never producer read history or held effects.
  for (const post of posts) await ledger.suppress({ owner: post.owner, key: squarePostKey(location, post), scope: 'exact' }, signal);
}
/** One export path for Square activities and Square-owned notices. No transaction spans I/O. */
export async function flushSquarePosts(artifact: SquareArtifactPort, location: string, clock: () => number, signal?: AbortSignal, ledgerLocation?: string): Promise<void> {
  signal ??= AbortSignal.timeout(5000);
  // Delivery enrichment cannot turn a committed producer mutation into a retry of that mutation.
  let lifetime: ReturnType<typeof retainDeliveryLedger> | undefined;
  try {
    const snapshot = (await artifact.read(facts => ({ pending: facts.pendingPosts(), posted: facts.postedPosts() }), signal)).value;
    if (!snapshot.pending.length && !snapshot.posted.length) return;
    const ledger = await openLedger(ledgerLocation, signal);
    lifetime = retainDeliveryLedger(ledger);
    for (const post of snapshot.pending) {
      const session = await ledger.session(post.owner, signal);
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
            ref: formatActivityId(post.index), author: post.from, body: post.body ?? '',
            ...(post.route === 'bell' ? { badge: '🔔' } : {}) } satisfies CardPresentation } : {}),
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
    const posts = (await artifact.read(facts => facts.postedPosts().filter(post => {
      const seat = facts.seat(post.recipient);
      return !post.consumed && seat?.owner === post.owner && seat.generation === post.generation;
    }), signal)).value;
    for (const owner of new Set(posts.map(post => post.owner))) {
      const session = await ledger.session(owner, signal);
      if (session?.state !== 'attached') continue;
      const pendingKeys = new Set((await ledger.pending(owner, { generation: session.generation }, signal)).map(card => card.key));
      for (const post of posts.filter(post => post.owner === owner)) {
        const key = squarePostKey(location, post);
        if (pendingKeys.has(key)) await dispatchPostedCard(ledger, post.owner, key, result => lifetime?.track(result), signal);
      }
    }
  } catch {
    // Unsettled/uncertain producer work is retried with its stable key at the next mutation.
    // Missing ledger evidence never proves that an external card was not inserted or delivered.
  } finally { await lifetime?.close(); }
}
