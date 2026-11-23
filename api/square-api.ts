import { Square as ApplicationSquare } from '../app/square.js';
import { SquareError, type Owner } from '../core/model.js';
import { requireOwner } from '../core/runtime.js';
import { DeliveryLedger, deliveryLedgerLocation } from '../ledger/delivery-ledger.js';
import { openReadOnlyDeliveryLedger } from '../ledger/delivery-lifetime.js';
import { dispatchPostedCard } from '../hosts/notifications.js';
import { muteDeadline, parseDurationMs } from '../core/time.js';
import { parseOperation, type MuteInput } from '../core/operation-inputs.js';
import type { OperationControl, Participant, SquareAtInput, SquareBuildInput } from './types.js';

export { migrateDeliveryLedger, type MigrateDeliveryLedgerInput, type MigrateDeliveryLedgerResult } from '../ledger/delivery-ledger.js';
export { DeliveryLedger, deliveryLedgerLocation } from '../ledger/delivery-ledger.js';
export { migrateSquare, type MigrateSquareResult } from '../artifact/migrate.js';
export type Square = ApplicationSquare;
export const Square = { at: (input: SquareAtInput, control?: OperationControl) => ApplicationSquare.at(input, dispatchPostedCard, control),
  build: (input: SquareBuildInput, control?: OperationControl) => ApplicationSquare.build(input, dispatchPostedCard, control),
  inMemory: (input: Omit<SquareBuildInput, 'path'>) => ApplicationSquare.inMemory(input, dispatchPostedCard) };

export { requireOwner, requireJoinName } from '../core/runtime.js';
export type * from './types.js';
export { squareLocation } from '../core/neutral.js';
export function selectOwnSeat(square: Pick<ApplicationSquare, 'participant' | 'seatsOf'>, owner: Owner | undefined, name?: string): Promise<Participant>;
export function selectOwnSeat(square: Pick<ApplicationSquare, 'participant' | 'seatsOf'>, owner: Owner | undefined, name: string | undefined, options: { readonly optional: true }): Promise<Participant | undefined>;
export async function selectOwnSeat(square: Pick<ApplicationSquare, 'participant' | 'seatsOf'>, owner: Owner | undefined, name?: string, options?: { readonly optional?: boolean }): Promise<Participant | undefined> {
  if (owner === undefined && options?.optional && name === undefined) return undefined;
  const caller = requireOwner(owner);
  if (name !== undefined) return square.participant(name, { owner: caller });
  // Selection is local producer custody, not a ledger attachment check.
  const seats = await square.seatsOf(caller);
  if (seats.length !== 1) {
    if (options?.optional) return undefined;
    throw new SquareError('invalid_args', seats.length > 1
      ? 'Square needs an explicit participant name: this owner holds multiple names'
      : 'Square needs one unambiguous participant name');
  }
  return square.participant(seats[0].name, { owner: caller });
}
export interface DeliveryMuteOptions {
  readonly ledgerLocation?: string;
  readonly clock?: () => number;
}
async function withDeliveryLedger<T>(input: DeliveryMuteOptions, control: OperationControl | undefined, run: (ledger: DeliveryLedger) => Promise<T>): Promise<T> {
  const ledger = await DeliveryLedger.open({
    location: input.ledgerLocation ?? deliveryLedgerLocation(),
    clock: input.clock,
    signal: control?.signal,
  });
  try { return await run(ledger); }
  finally { await ledger.close(); }
}
/** Set or release the all-owner hold. Independent seat and producer holds remain. */
export async function muteDeliveryLedger({ ledgerLocation, clock, ...input }: DeliveryMuteOptions & MuteInput, control?: OperationControl): Promise<{ readonly mutedUntil: number | null }> {
  const { duration } = parseOperation('mute', input);
  if (duration === 'off') return withDeliveryLedger({ ledgerLocation, clock }, control, ledger => ledger.unmute(control?.signal));
  const now = (clock ?? Date.now)(), durationMs = parseDurationMs(duration)!;
  muteDeadline(now, durationMs);
  return withDeliveryLedger({ ledgerLocation, clock: () => now }, control, ledger => ledger.mute({ durationMs }, control?.signal));
}
/** Read the active all-owner hold without creating an absent ledger. */
export async function deliveryLedgerMutedUntil(input: DeliveryMuteOptions = {}, control?: OperationControl): Promise<number | null> {
  const ledger = await openReadOnlyDeliveryLedger(input.ledgerLocation ?? deliveryLedgerLocation(), input.clock ?? Date.now, control?.signal);
  if (ledger === undefined) return null;
  try { return await ledger.mutedUntil(control?.signal); }
  finally { await ledger.close(); }
}
export { ACTIVITY_METADATA_MAX_BYTES } from '../core/model.js';
export { localUserOwner, harnessOwner, decodeHarnessOwner } from '../core/owner.js';
export { ACTIVITY_ID_PATTERN, formatActivityId, isNarratedActivity, MAX_IDENTITY_SET_SIZE, PAGE_CAP, parseActivityId,
  PERCEIVE_DEFAULT_LIMIT, DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT } from '../core/square-core.js';
export { HISTORY_DEFAULT_LIMIT } from '../core/observations.js';
export { diagnoseSquare } from '../app/square.js';
export { discover } from '../app/list.js';
export { inbox } from '../app/inbox.js';
