import { SquareError, sameBody, sameName, validateBody, validateName, type Body, type Seat } from './model.js';
import type { ArtifactWriteAuthority, SeatRef } from './ports.js';

export function requireBody(body: Body | undefined): Body {
  if (body === undefined) throw new SquareError('invalid_args', 'Participant writes require an explicit body: channel and session.');
  validateBody(body);
  return body;
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

export function requireSeat(seat: Seat | undefined, body: Body | undefined, participant: string): Seat {
  if (seat === undefined || !sameName(seat.participant, participant))
    throw new SquareError('already_joined', `${participant} needs a current participant handle; join first`);
  if (!sameBody(seat.body, requireBody(body)))
    throw new SquareError('already_joined', `${participant} is not held by this body`);
  return seat;
}
