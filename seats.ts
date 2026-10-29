import { SquareError, validateBody, validateName, type Body, type Seat } from './model.js';
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
  return { participant: seat.participant, body: seat.body, generation: seat.generation };
}

export function participantAuthority(seat: Seat): ArtifactWriteAuthority {
  return { kind: 'participant', seat: asSeatRef(seat) };
}
