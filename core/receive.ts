/** Synchronous capabilities borrowed from one caller-owned transaction. */
export interface Item<K extends string | number, D> { readonly key: K; readonly data: D }
export interface Address<V> { readonly recipient: string; readonly via: V }
export interface ReceivedHead<K extends string | number, V> { readonly key: K; readonly via: V }
export interface ReceiptRef<K extends string | number> { readonly recipient: string; readonly item: K }
export type PageQuery<Q> = { readonly query: Q; readonly limit: number };

export interface ReceiveRead<K extends string | number, D, V, Q> {
  heads(recipient: string, query: Q, options: { readonly unconsumed: boolean; readonly limit: number }): readonly ReceivedHead<K, V>[];
  load(keys: readonly K[]): ReadonlyMap<K, D>;
  count(recipient: string, query: Q, unconsumed: boolean): number;
  receipt(ref: ReceiptRef<K>): { readonly at: number } | undefined;
}
export interface ReceiveWrite<K extends string | number, D, V, Q> extends ReceiveRead<K, D, V, Q> {
  insertItem(item: Item<K, D>): void;
  insertAddress(item: K, address: Address<V>, order: number): void;
  /** True only for a new coordinate; an existing receipt retains its first timestamp. */
  insertReceipt(ref: ReceiptRef<K>, at: number): boolean;
}

export class ReceiveError<K extends string | number = string | number> extends Error {
  constructor(readonly code: 'missing_item', readonly key: K) {
    super(`${code}: ${String(key)}`);
    this.name = 'ReceiveError';
  }
}

/** Storage rejects duplicate items/addresses; the caller rolls back the whole admission. */
export function receive<K extends string | number, D, V>(
  tx: Pick<ReceiveWrite<K, D, V, unknown>, 'insertItem' | 'insertAddress'>,
  input: { readonly item: Item<K, D>; readonly audience: readonly Address<V>[] },
): void {
  tx.insertItem(input.item);
  input.audience.forEach((address, order) => tx.insertAddress(input.item.key, address, order));
}

/** Queries filter before limiting. */
export function selectReceivedHeads<K extends string | number, V, Q>(
  tx: Pick<ReceiveRead<K, unknown, V, Q>, 'heads'>, recipient: string, { query, limit }: PageQuery<Q>,
): readonly ReceivedHead<K, V>[] {
  if (typeof limit !== 'number') throw new TypeError('Receive limit must be a number.');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Receive limit must be a positive safe integer.');
  return tx.heads(recipient, query, { unconsumed: true, limit });
}

/** Record captured coordinates without reselecting or checking their current eligibility. */
export function recordConsumed<K extends string | number>(
  tx: Pick<ReceiveWrite<K, unknown, unknown, unknown>, 'insertReceipt'>,
  refs: readonly ReceiptRef<K>[], at: number,
): number {
  if (typeof at !== 'number') throw new TypeError('Receipt time must be a number.');
  if (!Number.isFinite(at)) throw new RangeError('Receipt time must be finite.');
  let count = 0;
  for (const ref of refs) if (tx.insertReceipt(ref, at)) count++;
  return count;
}

/** Selection, hydration, receipts and remaining count must share the caller's transaction. */
export function consumeReceived<K extends string | number, D, V, Q>(
  tx: Pick<ReceiveWrite<K, D, V, Q>, 'heads' | 'load' | 'insertReceipt' | 'count'>,
  recipient: string, page: PageQuery<Q>, at: number,
): { readonly items: readonly (Item<K, D> & { readonly via: V })[]; readonly newlyConsumed: number; readonly remaining: number } {
  const heads = selectReceivedHeads(tx, recipient, page);
  const data = tx.load(heads.map(head => head.key));
  const items = heads.map(head => {
    if (!data.has(head.key)) throw new ReceiveError('missing_item', head.key);
    return { key: head.key, data: data.get(head.key)!, via: head.via };
  });
  const newlyConsumed = recordConsumed(tx, heads.map(head => ({ recipient, item: head.key })), at);
  const remaining = tx.count(recipient, page.query, true);
  return { items, newlyConsumed, remaining };
}
