import type { ChannelRead, ChannelDeliveryEvidence as DeliveryEvidence, MessageHead } from './channel-ports.js';
import { automaticDispatchEligible, presentationBlocksDispatch, type Attempt } from './delivery-attempts.js';
function custody(evidence: readonly DeliveryEvidence[]): Pick<Attempt<unknown>, 'purpose' | 'outcome' | 'expiresAt'>[] {
  return evidence.map(row => ({ purpose: row.kind === 'wake' ? 'dispatch' : 'presentation', outcome: row.outcome, expiresAt: row.expiresAt }));
}

/** Presentation custody blocks a wake, independently of native wake acceptance. */
export function presentationBlocksWake(evidence: readonly DeliveryEvidence[], now: number): boolean {
  return presentationBlocksDispatch(custody(evidence), now);
}
/** Preselection only: an expired wake dispatch is uncertain, never safe automatic replay. */
export function automaticWakeEligible(evidence: readonly DeliveryEvidence[], now: number): boolean {
  return automaticDispatchEligible(custody(evidence), now);
}

/** One lower pending message: attached, unconsumed and not suppressed by a live claim. */
export function pendingHeadAt(facts: ChannelRead, name: string, index: number, now = Date.now()): MessageHead | undefined {
  const endpoint = facts.endpoint(name);
  if (endpoint === undefined || endpoint.attachment !== 'attached' || facts.receipt(endpoint.participant, index)) return undefined;
  if (facts.suppressed(endpoint.participant, endpoint.generation, index, now)) return undefined;
  return facts.directed(endpoint.participant, { afterIndex: index - 1, throughIndex: index, currentGeneration: true }, { edge: 'oldest', limit: 1 }).items[0];
}

/** Lower pending selection for one recipient, oldest first. */
export function pendingMessageHeads(facts: ChannelRead, name: string, now = Date.now(), suppress = true): MessageHead[] {
  const endpoint = facts.endpoint(name);
  if (endpoint === undefined || endpoint.attachment !== 'attached') return [];
  const heads: MessageHead[] = [];
  let afterIndex = -1;
  for (;;) {
    const page = facts.directed(endpoint.participant, { afterIndex, unseenOnly: true, currentGeneration: true }, { edge: 'oldest', limit: 100 });
    for (const head of page.items)
      if (!suppress || !facts.suppressed(endpoint.participant, endpoint.generation, head.index, now)) heads.push(head);
    if (!page.hasMore) break;
    afterIndex = page.items.at(-1)!.index;
  }
  return heads;
}

/** Lower recipients of one message that still owe a wake; other endpoints are untouched. */
export function pendingAddresses(facts: ChannelRead, index: number, now = Date.now()): readonly MessageHead[] {
  return facts.addresses(index).flatMap(({ recipient, generation }) => {
    const current = facts.endpoint(recipient);
    if (current === undefined || current.attachment !== 'attached') return [];
    if (generation !== undefined && current.generation !== generation) return [];
    const head = pendingHeadAt(facts, recipient, index, now);
    return head === undefined ? [] : [head];
  });
}

