import { closeOpenSquare, type OpenSquare } from './open-square.js';
import { buildMemorySquare, buildSquare, openSquare } from './square-file-adapter.js';
import { done, express, hold, ignore, implicitJoin, join, listen, listening, resume } from './landing.js';
import { catchUp, markBoundarySeen as recordBoundarySeen, markNotificationNotified as recordNotificationNotified } from './presence.js';
import { currentParticipant, history, participantHistory, participants, resolveParticipant, snapshot } from './views.js';
import { localParticipantName } from './registry.js';
import type { Activity, CatchOptions, CatchResult, ExpressOptions, ExpressResult, HistoryQuery, ListenerChangeResult, ParticipantStatus, PerceivedActivity, SquareSnapshot } from './square-facade.js';
import type { Participant, SquareAtInput, SquareBuildInput } from './square-facade.js';

class ParticipantHandle implements Participant {
  constructor(readonly name: string, private readonly square: OpenSquare) {}

  express(body: string, options?: ExpressOptions): Promise<ExpressResult> {
    return express(this.square, this.name, body, options);
  }

  listen(target: string): Promise<ListenerChangeResult> {
    return listen(this.square, this.name, target);
  }

  ignore(target: string): Promise<ListenerChangeResult> {
    return ignore(this.square, this.name, target);
  }

  listening(): Promise<readonly string[]> {
    return listening(this.square, this.name);
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

  async joinWithActivity(name: string): Promise<{ readonly participant: Participant; readonly activity: Activity | null }> {
    const joined = await join(this.square, name);
    return { participant: new ParticipantHandle(joined.name, this.square), activity: joined.activity };
  }

  async implicitJoin(name: string): Promise<{ readonly state: 'joined' | 'active' | 'done'; readonly participant?: Participant }> {
    const joined = await implicitJoin(this.square, name);
    return joined.state === 'done'
      ? { state: joined.state }
      : { state: joined.state, participant: new ParticipantHandle(joined.name, this.square) };
  }

  participants(): Promise<ParticipantStatus[]> { return participants(this.square); }
  snapshot(): Promise<SquareSnapshot> { return snapshot(this.square); }
  history(query?: HistoryQuery): Promise<Activity[]> { return history(this.square, query); }
  async recognize(env: NodeJS.ProcessEnv): Promise<Participant | null> {
    const registered = localParticipantName(this.square.location, env);
    if (registered === undefined) return null;
    const canonicalName = await currentParticipant(this.square, registered);
    return canonicalName === undefined ? null : new ParticipantHandle(canonicalName, this.square);
  }
  close(): Promise<void> { return closeOpenSquare(this.square); }
}

export function markBoundarySeen(squarePath: string, name: string, ownerId: string | undefined, actIndexes: readonly number[], at?: number): Promise<void> {
  return recordBoundarySeen(squarePath, name, ownerId, actIndexes, at);
}

export function markNotificationNotified(square: OpenSquare, name: string, actIndex: number, ownerId: string | undefined, at?: number): Promise<void> {
  return recordNotificationNotified(square, name, actIndex, ownerId, at);
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
