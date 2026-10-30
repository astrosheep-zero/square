import type { AudienceRoute } from './attention.js';
import type { StoredAct } from './model.js';
import type { DirectedFilter, SquareRead } from './ports.js';
import type { ReceiveRead } from './receive.js';

/** Transaction-local projections only; the artifact still owns indexed selection and bodies. */
export function squareReceiveRead(facts: SquareRead): ReceiveRead<number, StoredAct, AudienceRoute, DirectedFilter> {
  const filter = (query: DirectedFilter, unconsumed: boolean): DirectedFilter => {
    const { unseenOnly: _, ...rest } = query;
    return unconsumed ? { ...rest, unseenOnly: true } : rest;
  };
  return {
    heads: (recipient, query, options) => facts.directed(recipient, filter(query, options.unconsumed), { edge: 'oldest', limit: options.limit })
      .items.map(item => ({ key: item.index, via: item.route })),
    addressed(recipient, index) {
      const head = facts.directedAt(recipient, index);
      return head === undefined ? undefined : { key: head.index, via: head.route };
    },
    load: keys => new Map(facts.activities(keys).map(item => [item.index, item])),
    count: (recipient, query, unconsumed) => facts.directedCount(recipient, filter(query, unconsumed)),
    receipt: ref => facts.receipt(ref.recipient, ref.item),
  };
}
