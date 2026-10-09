import { closeOpenSquare, type OpenSquare } from './open-square.js';
import { buildMemorySquare, buildSquare, openSquare } from './square-file-adapter.js';
import {
  catchUp,
  done,
  endOwnedSession,
  express,
  hold,
  ignore,
  implicitJoin,
  join,
  takeover,
  listen,
  listening,
  resume,
  retireEndedSessionRoutes,
  type OperationContext,
} from './square-actions.js';
import { markBoundarySeen as recordBoundarySeen } from './presence.js';
import { history, participantHistory, participants, resolveParticipant, snapshot } from './views.js';
import { currentParticipant } from './views.js';
import type { Activity, CatchOptions, CatchResult, ExpressOptions, ExpressResult, HistoryQuery, ListenerChangeResult, ParticipantStatus, SquareSnapshot } from './square-facade.js';
import type { Participant, OperationControl, SquareAtInput, SquareBuildInput } from './square-facade.js';
import { projectSessionBindings } from './square-projections.js';
import { sessionIdsFromEnvironment } from './participant-identity.js';

class ParticipantHandle implements Participant {
  constructor(readonly name: string, private readonly square: OpenSquare, private readonly context: OperationContext) {}

  express(body: string, options?: ExpressOptions, control?: OperationControl): Promise<ExpressResult> {
    return express(this.context, this.name, body, options, control);
  }

  listen(target: string, control?: OperationControl): Promise<ListenerChangeResult> {
    return listen(this.context, this.name, target, control);
  }

  ignore(target: string, control?: OperationControl): Promise<ListenerChangeResult> {
    return ignore(this.context, this.name, target, control);
  }

  listening(control?: OperationControl): Promise<readonly string[]> {
    return listening(this.context, this.name, control);
  }

  catch(options?: CatchOptions, control?: OperationControl): Promise<CatchResult> {
    return catchUp(this.context, this.name, options, undefined, control);
  }

  history(query?: HistoryQuery, control?: OperationControl): Promise<Activity[]> {
    return participantHistory(this.square, this.name, query, control);
  }

  hold(reason?: string, control?: OperationControl): Promise<ExpressResult> {
    return hold(this.context, this.name, reason, control);
  }

  resume(control?: OperationControl): Promise<ExpressResult> {
    return resume(this.context, this.name, control);
  }

  done(body?: string, control?: OperationControl): Promise<ExpressResult> {
    return done(this.context, this.name, body, {}, control);
  }
}

export class Square {
  private readonly context: OperationContext;
  private constructor(readonly location: string, private readonly square: OpenSquare) {
    this.context = { ...square, location };
  }

  static async at(input: SquareAtInput): Promise<Square> {
    return new Square(input.path, await openSquare(input.path, input));
  }

  static async build(input: SquareBuildInput): Promise<Square> {
    return new Square(input.path, await buildSquare(input.path, input));
  }

  static inMemory(input: Omit<SquareBuildInput, 'path'>): Square {
    return new Square('memory', buildMemorySquare(input));
  }

  async join(name: string, control?: OperationControl): Promise<Participant> {
    const joined = await join(this.context, name, control);
    return new ParticipantHandle(joined.name, this.square, this.context);
  }

  async joinWithActivity(name: string, control?: OperationControl): Promise<{ readonly participant: Participant; readonly activity: Activity | null }> {
    const joined = await join(this.context, name, control);
    return { participant: new ParticipantHandle(joined.name, this.square, this.context), activity: joined.activity };
  }

  async takeoverWithActivity(name: string, control?: OperationControl): Promise<{ readonly participant: Participant; readonly activities: readonly Activity[] }> {
    const result = await takeover(this.context, name, [], control);
    return { participant: new ParticipantHandle(result.name, this.square, this.context), activities: result.activities };
  }

  async takeover(name: string, control?: OperationControl): Promise<Participant> {
    return (await this.takeoverWithActivity(name, control)).participant;
  }

  doneOwnedSession(name: string, body: string, expectedEpoch: number, control?: OperationControl): Promise<ExpressResult> {
    return done(this.context, name, body, { expectedEpoch }, control);
  }

  async implicitJoin(name: string, control?: OperationControl): Promise<{ readonly state: 'joined' | 'active' | 'done'; readonly participant?: Participant }> {
    const joined = await implicitJoin(this.context, name, control);
    return joined.state === 'done'
      ? { state: joined.state }
      : { state: joined.state, participant: new ParticipantHandle(joined.name, this.square, this.context) };
  }

  participants(): Promise<ParticipantStatus[]> { return participants(this.square); }
  snapshot(): Promise<SquareSnapshot> { return snapshot(this.square); }
  history(query?: HistoryQuery, control?: OperationControl): Promise<Activity[]> { return history(this.square, query, control); }
  async recognize(env: NodeJS.ProcessEnv): Promise<Participant | null> {
    if (this.square.hostLedger === undefined) return null;
    const sessions = sessionIdsFromEnvironment(env);
    if (sessions.length === 0) return null;
    const candidates = (await Promise.all(sessions.map((sessionId) => projectSessionBindings({
      hostLedger: this.square.hostLedger!,
      location: this.square.location,
      sessionId,
    })))).flat();
    if (candidates.length !== 1) return null;
    const canonicalName = await currentParticipant(this.square, candidates[0].participant);
    return canonicalName === undefined ? null : new ParticipantHandle(canonicalName, this.square, this.context);
  }
  close(): Promise<void> { return closeOpenSquare(this.square); }
  endOwnedSession(name: string, sessionId: string, expectedEpoch?: number) { return endOwnedSession(this.context, name, sessionId, expectedEpoch); }
  retireEndedSessionRoutes(sessionId: string): Promise<void> { return retireEndedSessionRoutes(this.context, sessionId); }
}

export function markBoundarySeen(squarePath: string, name: string, actIndexes: readonly number[], at?: number): Promise<void> {
  return recordBoundarySeen(squarePath, name, actIndexes, at);
}


export async function openParticipant(
  input: SquareAtInput,
  name: string,
): Promise<{ readonly participant: Participant; close(): Promise<void> }> {
  const square = await openSquare(input.path, input);
  try {
    const known = await resolveParticipant(square, name);
    return {
      participant: new ParticipantHandle(known.name, square, square),
      close: () => closeOpenSquare(square),
    };
  } catch (error) {
    await closeOpenSquare(square);
    throw error;
  }
}
