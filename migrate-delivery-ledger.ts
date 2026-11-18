import path from 'node:path';
import { encodeDeliveryKey, type DeliveryKey } from './delivery-key.js';
import { migrateLedgerStore } from './delivery-ledger-sqlite.js';
import { parseSquarePostKey, squarePostKey } from './square-post.js';

export interface MigrateDeliveryLedgerInput {
  readonly location: string;
  readonly convertOpaqueKey?: (key: string) => DeliveryKey | undefined;
  readonly convertOpaquePrefix?: (prefix: string) => DeliveryKey | undefined;
}
export interface MigrateDeliveryLedgerResult {
  readonly location: string;
  readonly fromVersion: 4 | 5;
  readonly toVersion: 5;
  readonly changed: boolean;
}

/** Strict historical producer grammar. Unknown/malformed identities require a converter. */
function legacySquareKey(key: string): DeliveryKey | undefined {
  const match = /^square:(.*)#(act|notice)\/(0|[1-9]\d*)\/recipient\/([^/]*)\/join\/([^/]*)$/s.exec(key);
  if (!match) return undefined;
  try {
    const [, location, tag, digits, escapedRecipient, escapedGeneration] = match;
    if (!path.isAbsolute(location!) || path.resolve(location!) !== location) return undefined;
    const index = Number(digits), recipient = decodeURIComponent(escapedRecipient!), generation = decodeURIComponent(escapedGeneration!);
    const result = squarePostKey(location!, { kind: tag === 'act' ? 'activity' : 'notice', index, recipient, generation });
    if (`square:${location}#${tag}/${index}/recipient/${encodeURIComponent(result[3]!)}/join/${encodeURIComponent(generation)}` !== key
      || !parseSquarePostKey(location!, result)) return undefined;
    return result;
  } catch { return undefined; }
}
function legacySquarePrefix(prefix: string): DeliveryKey | undefined {
  if (!prefix.startsWith('square:') || !prefix.endsWith('#')) return undefined;
  const location = prefix.slice(7, -1);
  return path.isAbsolute(location) && path.resolve(location) === location ? ['square', location] : undefined;
}

/** Explicit offline edge; ordinary opens never call this. Stop all ledger writers first. */
export function migrateDeliveryLedger(input: MigrateDeliveryLedgerInput, control?: { readonly signal?: AbortSignal }): Promise<MigrateDeliveryLedgerResult> {
  if (!input || typeof input.location !== 'string' || !path.isAbsolute(input.location)) throw new TypeError('Delivery location must be absolute');
  for (const converter of [input.convertOpaqueKey, input.convertOpaquePrefix])
    if (converter !== undefined && typeof converter !== 'function') throw new TypeError('Expected a synchronous delivery key converter');
  const converter = (prefix: boolean) => {
    const cache = new Map<string, string>();
    return (legacy: string): string => {
      let encoded = cache.get(legacy);
      if (encoded === undefined) {
        const key = (prefix ? legacySquarePrefix(legacy) : legacySquareKey(legacy))
          ?? (prefix ? input.convertOpaquePrefix : input.convertOpaqueKey)?.(legacy);
        if (key === undefined) throw new Error(`No conversion for opaque delivery ${prefix ? 'prefix' : 'key'}: ${JSON.stringify(legacy)}`);
        encoded = encodeDeliveryKey(key, prefix);
        cache.set(legacy, encoded);
      }
      return encoded;
    };
  };
  return migrateLedgerStore(input.location, converter(false), converter(true), control?.signal);
}
