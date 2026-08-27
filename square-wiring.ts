import { closeOpenSquare, type OpenSquare } from './open-square.js';
import { buildMemorySquare, buildSquare, openSquare } from './square-file-adapter.js';
import { ActivityApplication } from './application.js';
import { markBoundarySeen as recordBoundarySeen } from './presence.js';
import { history, participantHistory, participants, resolveParticipant, snapshot } from './views.js';
import { currentParticipant } from './views.js';
import type { Activity, CatchOptions, CatchResult, ExpressOptions, ExpressResult, HistoryQuery, ListenerChangeResult, ParticipantStatus, PerceivedActivity, SquareSnapshot } from './square-facade.js';
import type { Participant, SquareAtInput, SquareBuildInput } from './square-facade.js';
import { projectSessionBindings, reconcileBinding as reconcileBindingOperation } from './application.js';

class ParticipantHandle implements Participant {
  constructor(readonly name: string, private readonly square: OpenSquare, private readonly application: ActivityApplication) {}

  express(body: string, options?: ExpressOptions): Promise<ExpressResult> {
    return this.application.express({ name: this.name, body, ...(options === undefined ? {} : { options }) });
  }

  listen(target: string): Promise<ListenerChangeResult> {
    return this.application.listen({ name: this.name, target });
  }

  ignore(target: string): Promise<ListenerChangeResult> {
    return this.application.ignore({ name: this.name, target });
  }

  listening(): Promise<readonly string[]> {
    return this.application.listening(this.name);
  }

  catch(options?: CatchOptions): Promise<CatchResult> {
    return this.application.catch({ name: this.name, ...(options === undefined ? {} : { options }) });
  }

  history(query?: HistoryQuery): Promise<PerceivedActivity[]> {
    return participantHistory(this.square, this.name, query);
  }

  hold(reason?: string): Promise<ExpressResult> {
    return this.application.hold({ name: this.name, ...(reason === undefined ? {} : { body: reason }) });
  }

  resume(): Promise<ExpressResult> {
    return this.application.resume({ name: this.name });
  }

  done(body?: string): Promise<ExpressResult> {
    return this.application.done({ name: this.name, ...(body === undefined ? {} : { body }) });
  }
}

export class Square {
  private readonly application: ActivityApplication;
  private constructor(readonly location: string, private readonly square: OpenSquare) {
    this.application = new ActivityApplication({ ...square, location });
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

  async join(name: string): Promise<Participant> {
    const joined = await this.application.join({ name });
    return new ParticipantHandle(joined.name, this.square, this.application);
  }

  async joinWithActivity(name: string): Promise<{ readonly participant: Participant; readonly activity: Activity | null }> {
    const joined = await this.application.join({ name });
    return { participant: new ParticipantHandle(joined.name, this.square, this.application), activity: joined.activity };
  }

  async implicitJoin(name: string): Promise<{ readonly state: 'joined' | 'active' | 'done'; readonly participant?: Participant }> {
    const joined = await this.application.implicitJoin({ name });
    return joined.state === 'done'
      ? { state: joined.state }
      : { state: joined.state, participant: new ParticipantHandle(joined.name, this.square, this.application) };
  }

  participants(): Promise<ParticipantStatus[]> { return participants(this.square); }
  snapshot(): Promise<SquareSnapshot> { return snapshot(this.square); }
  history(query?: HistoryQuery): Promise<Activity[]> { return history(this.square, query); }
  async recognize(env: NodeJS.ProcessEnv): Promise<Participant | null> {
    if (this.square.hostLedger === undefined) return null;
    const sessions = [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID, env.OPENCODE_SESSION_ID, env.SQUARE_PI_SESSION_ID, env.PASEO_AGENT_ID]
      .map((value) => value?.trim()).filter((value): value is string => Boolean(value));
    if (sessions.length === 0) return null;
    const candidates = (await Promise.all(sessions.map((sessionId) => projectSessionBindings({
      hostLedger: this.square.hostLedger!,
      location: this.square.location,
      sessionId,
      scopes: ['user', 'local'],
    })))).flat();
    if (candidates.length !== 1) return null;
    const canonicalName = await currentParticipant(this.square, candidates[0].participant);
    return canonicalName === undefined ? null : new ParticipantHandle(canonicalName, this.square, this.application);
  }
  close(): Promise<void> { return closeOpenSquare(this.square); }
  reconcileBinding() { return reconcileBindingOperation({ artifact: this.square.artifact, hostLedger: this.square.hostLedger!, location: this.location }); }
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
      participant: new ParticipantHandle(known.name, square, new ActivityApplication(square)),
      close: () => closeOpenSquare(square),
    };
  } catch (error) {
    await closeOpenSquare(square);
    throw error;
  }
}
