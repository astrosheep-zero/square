import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeliveryLedger, type DeliveryRoute, type DeliverySession } from './delivery-ledger.js';
import { dispatchPostedCard } from './notifications.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';
import { projectNotification } from './attention-presentation.js';
import { coreDone } from './decisions.js';
import { activityMetadataHasContent, type Seat } from './model.js';
import type { SquareArtifactPort } from './ports.js';
import { squarePostKey, type SquarePost } from './square-post.js';

const openLedger = (env: NodeJS.ProcessEnv) => DeliveryLedger.open({
  location: env.SQUARE_DELIVERY ?? path.join(os.homedir(), '.square', 'delivery.sqlite'),
});
function renderPost(location: string, post: SquarePost): { text: string; full: boolean } {
  if (post.kind === 'notice') return { text: post.body ?? '', full: true };
  const projected = projectNotification({ squarePath: location, actIndex: post.index, recipient: post.recipient,
    actor: post.from, route: post.route!, body: post.body ?? '',
    metadataOnly: !(post.body?.trim()) && activityMetadataHasContent(post.metadata) });
  return { text: projected.text, full: projected.isFull };
}
/** Local producer custody and current host attachment are different observations. */
export async function deliverySessionsForSeats(ledger: DeliveryLedger, seats: readonly Seat[]): Promise<ReadonlyMap<string, DeliverySession | undefined>> {
  const owners = [...new Set(seats.map(seat => seat.owner))];
  return new Map(await Promise.all(owners.map(async owner => [owner, await ledger.session(owner)] as const)));
}
/** Read-only host observations for status; callers fence them against the captured World seats. */
export async function readSquareSessions(seats: readonly Seat[], env: NodeJS.ProcessEnv): Promise<ReadonlyMap<string, DeliverySession | undefined>> {
  if (!seats.length) return new Map();
  const ledger = await openLedger(env);
  try { return await deliverySessionsForSeats(ledger, seats); }
  finally { await ledger.close(); }
}
/** A first producer join may register an absent owner, never resume or revive one. */
export async function ensureInitialDeliverySession(owner: Seat['owner'], env: NodeJS.ProcessEnv, route?: DeliveryRoute): Promise<boolean> {
  const ledger = await openLedger(env);
  try {
    const current = await ledger.session(owner);
    if (!current) {
      return !!await ledger.attach({ owner, expectedGeneration: null, routes: route ? [route] : [] });
    }
    if (current.state !== 'attached') return false;
    if (route) return ledger.updateRoutes({ owner, generation: current.generation,
      routes: [...current.routes.filter(candidate => candidate.kind !== route.kind), route] });
    return true;
  } finally { await ledger.close(); }
}
/** Called only by privileged mutations. Sandbox lease/ACK/selection never enters here. */
export async function reconcileSquareDelivery(artifact: SquareArtifactPort, location: string, env: NodeJS.ProcessEnv, clock: () => number): Promise<void> {
  const snapshot = (await artifact.read(facts => ({ seats: facts.roster().filter(person => person.joined)
    .flatMap(person => { const seat = facts.seat(person.name); return seat ? [seat] : []; }), posts: facts.postedPosts() }))).value;
  if (!snapshot.seats.length && !snapshot.posts.length) return;
  const ledger = await openLedger(env);
  try {
    const sessions = await deliverySessionsForSeats(ledger, snapshot.seats);
    for (const seat of snapshot.seats) {
      const session = sessions.get(seat.owner);
      if (!session) continue;
      if (session.state === 'deleted') {
        await artifact.transactAs({ kind: 'host-cleanup', seat }, facts => {
          const current = facts.seat(seat.participant);
          if (current?.owner === seat.owner && current.generation === seat.generation && facts.participant(seat.participant)?.joined)
            facts.land(coreDone(facts, seat.participant, '', clock()));
        });
      } else if (seat.attachment !== session.state) {
        const attachment = session.state;
        await artifact.transactAs({ kind: 'producer' }, facts => facts.setSeatAttachment(seat, attachment));
      }
    }
    // A full receipt is monotonic external presentation evidence, never inferred from silence.
    const receipts = new Map<string, ReadonlyMap<string, number>>();
    for (const owner of new Set(snapshot.posts.map(post => post.owner))) {
      const keys = snapshot.posts.filter(post => post.owner === owner).map(post => squarePostKey(location, post));
      receipts.set(owner, new Map((await ledger.receipts(owner, { keys })).map(receipt => [receipt.key, receipt.at])));
    }
    for (const post of snapshot.posts) {
      const cardKey = squarePostKey(location, post);
      const receipt = receipts.get(post.owner)?.get(cardKey);
      if (receipt !== undefined && post.full === true && !post.consumed)
        await artifact.transactAs({ kind: 'producer' }, facts => facts.foldReceipt(post, receipt));
    }
    await retractWithdrawn(artifact, ledger, location);
  } finally { await ledger.close(); }
}
async function retractWithdrawn(artifact: SquareArtifactPort, ledger: DeliveryLedger, location: string): Promise<void> {
  const posts = (await artifact.read(facts => facts.postedPosts().filter(post => {
    const seat = facts.seat(post.recipient);
    return post.consumed || !seat || seat.owner !== post.owner || seat.generation !== post.generation;
  }))).value;
  // Departure withdraws only the captured notification, never producer read history or held effects.
  for (const post of posts) await ledger.retract({ owner: post.owner, key: squarePostKey(location, post) });
}
/** One export path for Square activities and Square-owned notices. No transaction spans I/O. */
export async function flushSquarePosts(artifact: SquareArtifactPort, location: string, env: NodeJS.ProcessEnv, clock: () => number): Promise<void> {
  // Delivery enrichment cannot turn a committed producer mutation into a retry of that mutation.
  let lifetime: ReturnType<typeof retainDeliveryLedger> | undefined;
  try {
    const snapshot = (await artifact.read(facts => ({ pending: facts.pendingPosts(), posted: facts.postedPosts() }))).value;
    if (!snapshot.pending.length && !snapshot.posted.length) return;
    const ledger = await openLedger(env);
    lifetime = retainDeliveryLedger(ledger);
    for (const post of snapshot.pending) {
      const session = await ledger.session(post.owner);
      if (session?.state !== 'attached') continue;
      const rendered = renderPost(location, post), token = randomUUID();
      const owned = (await artifact.transactAs({ kind: 'producer' }, facts =>
        facts.acquirePost({ ...post, full: rendered.full }, token, process.pid, clock(), Date.now()))).value;
      if (!owned) continue;
      let posted = false, knownUnsent = true;
      try {
        // This check is not custody across the await; the ledger independently fences delivery.
        const current = await ledger.session(post.owner);
        if (current?.state !== 'attached' || current.generation !== session.generation
          || !(await artifact.read(facts => facts.ownsPost(token, Date.now()))).value) continue;
        knownUnsent = false;
        const result = await ledger.post({ owner: post.owner, key: squarePostKey(location, post), text: rendered.text });
        posted = ['posted', 'duplicate', 'retracted'].includes(result.status);
        knownUnsent = !posted;
        if (result.status === 'conflict') throw new Error('A Square card key already holds different text.');
      } finally {
        const disposition = posted ? 'posted' : owned === 'initial' && knownUnsent ? 'never-exported' : 'uncertain';
        await artifact.settleAs({ kind: 'producer' }, facts => facts.settlePost(token, rendered.full, disposition));
      }
    }
    await retractWithdrawn(artifact, ledger, location);
    // Insertion is durable producer progress; dispatch remains retryable through ledger custody.
    const posts = (await artifact.read(facts => facts.postedPosts().filter(post => {
      const seat = facts.seat(post.recipient);
      return !post.consumed && seat?.owner === post.owner && seat.generation === post.generation;
    }))).value;
    for (const owner of new Set(posts.map(post => post.owner))) {
      const session = await ledger.session(owner);
      if (session?.state !== 'attached') continue;
      const pendingKeys = new Set((await ledger.pending(owner, { generation: session.generation })).map(card => card.key));
      for (const post of posts.filter(post => post.owner === owner)) {
        const key = squarePostKey(location, post);
        if (pendingKeys.has(key)) await dispatchPostedCard(ledger, owner, key, lifetime.track, env);
      }
    }
  } catch {
    // Unsettled/uncertain producer work is retried with its stable key at the next mutation.
    // Missing ledger evidence never proves that an external card was not inserted or delivered.
  } finally { await lifetime?.close(); }
}
