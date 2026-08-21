import { closeOpenSquare, type OpenSquare } from './open-square.js';
import { buildMemorySquare, buildSquare, openSquare } from './square-file-adapter.js';
import { done, express, hold, join, resume } from './landing.js';
import { catchUp } from './presence.js';
import { history, participantHistory, participants, resolveParticipant, snapshot } from './views.js';
import type { Activity, CatchOptions, CatchResult, ExpressOptions, ExpressResult, HistoryQuery, ParticipantStatus, PerceivedActivity, SquareSnapshot } from './square-facade.js';
import type { Participant, SquareAtInput, SquareBuildInput } from './square-facade.js';

class ParticipantHandle implements Participant {
  constructor(readonly name: string, private readonly square: OpenSquare) {}

  express(body: string, options?: ExpressOptions): Promise<ExpressResult> {
    return express(this.square, this.name, body, options);
  }

  catch(options?: CatchOptions): Promise<CatchResult> {
    return catchUp(this.square, this.name, options);
  }

  history(query?: HistoryQuery): Promise<PerceivedActivity[]> {
    return participantHistory(this.square, this.name, query);
  }

  hold(reason?: string): Promise<ExpressResult> {
    return hold(this.square, this.name, reason);
  }

  resume(): Promise<ExpressResult> {
    return resume(this.square, this.name);
  }

  done(body?: string): Promise<ExpressResult> {
    return done(this.square, this.name, body);
  }
}

export class Square {
  private constructor(readonly location: string, private readonly square: OpenSquare) {}

  static async at(input: SquareAtInput): Promise<Square> {
    return new Square(input.path, await openSquare(input.path, input));
  }

  static async build(input: SquareBuildInput): Promise<Square> {
    return new Square(input.path, await buildSquare(input.path, input));
  }

  static inMemory(input: Omit<SquareBuildInput, 'path'>): Square {
    return new Square('memory', buildMemorySquare(input));
  }

  async join(name: string): Promise<Participant> {
    const joined = await join(this.square, name);
    return new ParticipantHandle(joined.name, this.square);
  }

  participants(): Promise<ParticipantStatus[]> { return participants(this.square); }
  snapshot(): Promise<SquareSnapshot> { return snapshot(this.square); }
  history(query?: HistoryQuery): Promise<Activity[]> { return history(this.square, query); }
  close(): Promise<void> { return closeOpenSquare(this.square); }
}

export async function openParticipant(
  input: SquareAtInput,
  name: string,
): Promise<{ readonly participant: Participant; close(): Promise<void> }> {
  const square = await openSquare(input.path, input);
  try {
    const known = await resolveParticipant(square, name);
    return {
      participant: new ParticipantHandle(known.name, square),
      close: () => closeOpenSquare(square),
    };
  } catch (error) {
    await closeOpenSquare(square);
    throw error;
  }
}
