import {
  type Activity,
  type CatchOptions,
  type CatchResult,
  type ExpressOptions,
  type ExpressResult,
  type HistoryQuery,
  type ParticipantStatus,
  type PerceivedActivity,
  type SquareApplication,
  type SquareSnapshot,
} from './square-engine.js';
import { buildFileApplication, buildMemoryApplication, openFileApplication } from './square-file-adapter.js';
import type { Participant, SquareAtInput, SquareBuildInput } from './square-facade.js';

class ParticipantHandle implements Participant {
  constructor(readonly name: string, private readonly application: SquareApplication) {}

  express(body: string, options?: ExpressOptions): Promise<ExpressResult> {
    return this.application.express(this.name, body, options);
  }

  catch(options?: CatchOptions): Promise<CatchResult> {
    return this.application.catch(this.name, options);
  }

  history(query?: HistoryQuery): Promise<PerceivedActivity[]> {
    return this.application.participantHistory(this.name, query);
  }

  hold(reason?: string): Promise<ExpressResult> {
    return this.application.hold(this.name, reason);
  }

  resume(): Promise<ExpressResult> {
    return this.application.resume(this.name);
  }

  done(body?: string): Promise<ExpressResult> {
    return this.application.done(this.name, body);
  }
}

export class Square {
  private constructor(readonly location: string, private readonly application: SquareApplication) {}

  static async at(input: SquareAtInput): Promise<Square> {
    return new Square(input.path, await openFileApplication(input.path, input));
  }

  static async build(input: SquareBuildInput): Promise<Square> {
    return new Square(input.path, await buildFileApplication(input.path, input));
  }

  static inMemory(input: Omit<SquareBuildInput, 'path'>): Square {
    return new Square('memory', buildMemoryApplication(input));
  }

  async join(name: string): Promise<Participant> {
    const joined = await this.application.join(name);
    return new ParticipantHandle(joined.name, this.application);
  }

  participants(): Promise<ParticipantStatus[]> { return this.application.participants(); }
  snapshot(): Promise<SquareSnapshot> { return this.application.snapshot(); }
  history(query?: HistoryQuery): Promise<Activity[]> { return this.application.history(query); }
  close(): Promise<void> { return this.application.close(); }
}
