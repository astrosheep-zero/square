import type { DeliveryKey } from '../core/delivery-key.js';
import type { DeliveryLedger, DeliverySession } from '../ledger/delivery-ledger.js';
import { nameKey, type Owner, type Seat } from '../core/model.js';
import { openReadOnlyDeliveryLedger } from '../ledger/delivery-lifetime.js';
import { deliverySessionsForSeats } from './square-posting.js';

/** One captured Square seat generation, independent from every other layer. */
export function seatMutePrefix(location: string, seat: Pick<Seat, 'participant' | 'generation'>): DeliveryKey {
  return ['square', location, 'recipient', nameKey(seat.participant), 'join', seat.generation];
}

export function seatMuteId(owner: Owner, prefix: DeliveryKey): string {
  return 'square-mute:' + JSON.stringify([owner, prefix]);
}

/** Stable in-memory identity for joining captured and rechecked seats. */
export function seatMuteKey(seat: Pick<Seat, 'participant' | 'owner' | 'generation'>): string {
  return JSON.stringify([seat.owner, nameKey(seat.participant), seat.generation]);
}

export interface SquareMuteDeadlines {
  readonly ledgerMutedUntil?: number;
  readonly seatMutedUntil: ReadonlyMap<string, number>;
}

export interface SquareHostObservations extends SquareMuteDeadlines {
  readonly sessions: ReadonlyMap<string, DeliverySession | undefined>;
}

async function readSeatMutes(ledger: DeliveryLedger, location: string, seats: readonly Seat[], signal?: AbortSignal): Promise<ReadonlyMap<string, number>> {
  const active = new Map<string, number>();
  for (const seat of seats) {
    const prefix = seatMutePrefix(location, seat);
    const hold = await ledger.suppression({ owner: seat.owner, id: seatMuteId(seat.owner, prefix) }, signal);
    if (hold?.expiresAt !== undefined) active.set(seatMuteKey(seat), hold.expiresAt);
  }
  return active;
}

/** Read one active all-owner hold without creating an absent ledger. */
export async function readLedgerMutedUntil(ledgerLocation: string, clock: () => number, signal?: AbortSignal): Promise<number | undefined> {
  const ledger = await openReadOnlyDeliveryLedger(ledgerLocation, clock, signal);
  if (ledger === undefined) return undefined;
  try { return (await ledger.mutedUntil(signal)) ?? undefined; }
  finally { await ledger.close(); }
}

/** Read only captured seat holds; global state is read once per listing operation. */
export async function readSquareSeatMutes(location: string, seats: readonly Seat[], clock: () => number, signal: AbortSignal | undefined, ledgerLocation: string): Promise<ReadonlyMap<string, number>> {
  if (!seats.length) return new Map();
  const ledger = await openReadOnlyDeliveryLedger(ledgerLocation, clock, signal);
  if (ledger === undefined) return new Map();
  try { return await readSeatMutes(ledger, location, seats, signal); }
  finally { await ledger.close(); }
}

/** One read-only ledger open for status: sessions, the global hold and captured seats. */
export async function readSquareHostObservations(location: string, seats: readonly Seat[], clock: () => number, signal: AbortSignal | undefined, ledgerLocation: string): Promise<SquareHostObservations> {
  const ledger = await openReadOnlyDeliveryLedger(ledgerLocation, clock, signal);
  if (ledger === undefined) return { sessions: new Map(), seatMutedUntil: new Map() };
  try {
    const ledgerMutedUntil = (await ledger.mutedUntil(signal)) ?? undefined;
    return {
      sessions: await deliverySessionsForSeats(ledger, seats, signal),
      ...(ledgerMutedUntil === undefined ? {} : { ledgerMutedUntil }),
      seatMutedUntil: await readSeatMutes(ledger, location, seats, signal),
    };
  } finally { await ledger.close(); }
}
