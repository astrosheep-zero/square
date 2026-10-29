import { SquareError, validateOwner, validateName, type Owner, type Seat } from './model.js';
import type { ArtifactWriteAuthority, SeatRef } from './ports.js';

export function requireOwner(owner: Owner | undefined): Owner {
  if (owner === undefined) throw new SquareError('invalid_args', 'Participant writes require an explicit owner.');
  validateOwner(owner);
  return owner;
}

export function requireJoinName(name: string | undefined): string {
  if (name === undefined) throw new SquareError('invalid_args', 'Square.join requires an explicit participant name.');
  validateName(name);
  return name;
}

export function asSeatRef(seat: Seat): SeatRef {
  return { participant: seat.participant, owner: seat.owner, generation: seat.generation };
}

export function participantAuthority(seat: Seat): ArtifactWriteAuthority {
  return { kind: 'participant', seat: asSeatRef(seat) };
}
