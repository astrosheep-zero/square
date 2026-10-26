import { SquareError, sameBody, sameName, validateBody, validateName, type Body, type Seat, type WakeAddress } from './model.js';
import type { ArtifactWriteAuthority, SeatRef, SquareArtifactPort } from './ports.js';
import { rememberSquarePath } from './square-index.js';

export function requireBody(context: HostContext): Body {
  if (context.body === undefined) throw new SquareError('invalid_args', 'Participant writes require an explicit body: channel and session.');
  validateBody(context.body);
  return context.body;
}

export function requireJoinName(name: string | undefined): string {
  if (name === undefined) throw new SquareError('invalid_args', 'Square.join requires an explicit participant name.');
  validateName(name);
  return name;
}

export function asSeatRef(seat: Seat): SeatRef {
  const { wakeAddress: _wakeAddress, ...ref } = seat;
  return ref;
}

export function participantAuthority(seat: Seat): ArtifactWriteAuthority {
  return { kind: 'participant', seat: asSeatRef(seat) };
}

export interface HostContext {
  readonly artifact: SquareArtifactPort;
  readonly automaticDelivery?: boolean;
  readonly clock: () => number;
  readonly location?: string;
  readonly indexPath?: string;
  readonly body?: Body;
  readonly wakeAddress?: WakeAddress;
  readonly participantSeat?: Seat;
}

export function requireSeat(context: HostContext, participant: string): Seat {
  const seat = context.participantSeat;
  if (seat === undefined || !sameName(seat.participant, participant))
    throw new SquareError('already_joined', `${participant} needs a current participant handle; join first`);
  if (!sameBody(seat.body, requireBody(context)))
    throw new SquareError('already_joined', `${participant} is not held by this body`);
  return seat;
}

/** Post-commit discovery only. The index never decides whether this seat may write. */
export async function publishCommittedIdentity(context: HostContext): Promise<void> {
  if (context.location === undefined || context.location === 'memory' || context.body === undefined || context.indexPath === undefined) return;
  await rememberSquarePath(context.location, context.body, context.indexPath).catch(() => undefined);
}
