import { SqliteSquare } from './sqlite-square.js';
import { SquareError } from './model.js';
import { requireOwner } from './seats.js';
import type { Owner } from './model.js';
import type { Participant } from './square-facade.js';

export { requireOwner, requireJoinName } from './seats.js';
export type * from './square-facade.js';
export { squareLocation } from './square-location.js';
export function selectOwnSeat(square: Pick<SqliteSquare, 'participant' | 'seatsOf'>, owner: Owner | undefined, name?: string): Promise<Participant>;
export function selectOwnSeat(square: Pick<SqliteSquare, 'participant' | 'seatsOf'>, owner: Owner | undefined, name: string | undefined, options: { readonly optional: true }): Promise<Participant | undefined>;
export async function selectOwnSeat(square: Pick<SqliteSquare, 'participant' | 'seatsOf'>, owner: Owner | undefined, name?: string, options?: { readonly optional?: boolean }): Promise<Participant | undefined> {
  if (owner === undefined && options?.optional && name === undefined) return undefined;
  const caller = requireOwner(owner);
  if (name !== undefined) return square.participant(name, { owner: caller });
  const seats = (await square.seatsOf(caller)).filter(seat => seat.attachment === 'attached');
  if (seats.length !== 1) {
    if (options?.optional) return undefined;
    throw new SquareError('invalid_args', seats.length > 1
      ? 'Square needs an explicit participant name: this owner holds multiple names'
      : 'Square needs one unambiguous participant name');
  }
  return square.participant(seats[0].name, { owner: caller });
}
export { ACTIVITY_METADATA_MAX_BYTES } from './model.js';
export { localUserOwner, harnessOwner, decodeHarnessOwner } from './owner.js';
export { SqliteSquare as Square, squareClock, createSquareResourceOwner, formatActivityId, parseActivityId, MAX_IDENTITY_SET_SIZE,
  CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT, HELD_WAIT_BUDGET_MS, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT,
  DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT,
  diagnoseSquare, migrateSquare, discover, inbox } from './sqlite-square.js';
