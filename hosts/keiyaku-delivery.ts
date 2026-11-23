import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DeliveryCard, DeliveryTransport, DeliveryTransportContext, TransportOutcome } from '../ledger/delivery-ledger.js';
import { akumaDeliveryOwner, requireAkumaActor } from '../core/owner.js';
import { formatActivityId } from '../core/square-core.js';
import { parseSquarePostKey } from '../core/delivery-key.js';
import { spellAction } from '../surfaces/operations.js';

interface AkumaTarget {
  readonly id: string;
  tell(prompt: string, options: { wait: false; signal: AbortSignal }): Promise<unknown>;
}
interface KeiyakuSdk {
  readonly World: { prove(path: string): Promise<string>; established(root: string): Promise<boolean> };
  readonly Akuma: { select(root: string, id: string): AkumaTarget };
  readonly AkumaNotBornError: typeof Error;
}

/** Node resolves from this installed module, never the sender's working directory. */
async function loadKeiyaku(): Promise<KeiyakuSdk> {
  const override = process.env.SQUARE_KEIYAKU_SDK;
  if (override !== undefined && !path.isAbsolute(override)) throw new Error('Expected an absolute Keiyaku SDK entry point');
  const sdk: Partial<KeiyakuSdk> = await import(override === undefined ? '@astrosheep/keiyaku' : pathToFileURL(override).href);
  if (typeof sdk.World?.prove !== 'function' || typeof sdk.World.established !== 'function'
    || typeof sdk.Akuma?.select !== 'function' || typeof sdk.AkumaNotBornError !== 'function') {
    throw new Error('Installed Keiyaku SDK does not expose native Tell');
  }
  return sdk as KeiyakuSdk;
}

function confirmsAdmission(value: unknown, akuId: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const { kind, tellId, akumaId } = value as Record<string, unknown>;
  // A wake failure *with an admission receipt* is not permission to resubmit.
  return (kind === 'admitted' || kind === 'failed') && akumaId === akuId && typeof tellId === 'string' && tellId.length > 0;
}

/** Only Square's producer loop authorizes this route, from its landed mention facts. */
export class KeiyakuWakeTransport implements DeliveryTransport {
  readonly kind = 'keiyaku';
  private sdk?: Promise<KeiyakuSdk>;
  constructor(private readonly load = loadKeiyaku) {}

  async send(card: DeliveryCard, address: Readonly<Record<string, string>>, context: DeliveryTransportContext): Promise<TransportOutcome> {
    const location = card.key[1];
    const post = location && path.isAbsolute(location) ? parseSquarePostKey(location, card.key) : undefined;
    if (post?.kind !== 'activity') return 'not-capable';
    const args = { location, ids: [formatActivityId(post.index)] };
    const prompt = ['A Square mention reached you. Take it in if unread:',
      spellAction({ operation: 'perceive', args: { ...args, as: post.recipientKey }, absoluteLocation: true }, 'tool'),
      'To reread the full activity:',
      spellAction({ operation: 'history', args: { ...args, maxChars: Number.MAX_SAFE_INTEGER }, absoluteLocation: true }, 'tool'),
    ].join('\n');
    const current = () => !context.signal.aborted && Date.now() < context.deadline;
    let sdk: KeiyakuSdk, target: AkumaTarget, akuId: string;
    try {
      const actor = requireAkumaActor(address);
      if (card.owner !== akumaDeliveryOwner(actor) || !current()) return 'not-capable';
      sdk = await (this.sdk ??= this.load());
      if (!current()) return 'not-capable';
      const world = await sdk.World.prove(actor.world);
      if (!current() || world !== actor.world || !await sdk.World.established(world) || !current()) return 'not-capable';
      akuId = actor.akuId;
      target = sdk.Akuma.select(world, akuId);
      if (target.id !== akuId) return 'not-capable';
      if (!await context.prepare({ payloadHash: createHash('sha256').update(prompt).digest('hex') }) || !current()
        || !await context.beforeSend() || !current()) return 'not-capable';
    } catch { return 'not-capable'; }
    try {
      const receipt = await target.tell(prompt, { wait: false, signal: context.signal });
      return confirmsAdmission(receipt, akuId) ? 'accepted' : 'unknown';
    } catch (error) {
      if (error instanceof sdk.AkumaNotBornError) return 'failed';
      const receipt = error instanceof Error ? (error as Error & { tell?: unknown }).tell : undefined;
      return confirmsAdmission(receipt, akuId) ? 'accepted' : 'unknown';
    }
  }
}
