import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SquareError } from './model.js';
import { currentHold } from './runtime.js';
import type { HostLedgerPort, WakeTransportPort } from './ports.js';
import { Square, openParticipant } from './square-wiring.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare, type OpenSquare } from './open-square.js';
import { statusPresentation, participantsPresentation } from './views.js';
import { hostLedgerForEnv, localParticipantName, localSessionIdentities, readParticipantOwner } from './registry.js';
import type { Activity, CatchOptions, CatchResult, ExpressOptions, ExpressResult, HistoryQuery, ListenerChangeResult, Participant, ParticipantStatus, PerceivedActivity, OperationControl } from './square-facade.js';

/** Final control coordinate shared by facade, actions, and application adapters. */
export interface SquareApplicationContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly squarePath?: string;
  readonly participant?: string;
  readonly clock?: () => number;
  readonly hostLedger?: HostLedgerPort;
  readonly wakeTransport?: WakeTransportPort;
}
export interface JoinApplicationOptions { readonly takeover?: boolean }
export interface JoinApplicationResult {
  readonly participant: string;
  readonly activity: Activity | null;
  readonly kind: 'joined' | 'reconnected' | 'taken-over';
  readonly participantCount: number;
}
export interface ExpressApplicationOptions extends ExpressOptions {
  readonly noWait?: boolean;
}
export interface ExpressApplicationResult extends ExpressResult { readonly waited: boolean }
export interface ApplicationStatus {
  readonly context: string;
  readonly actCount: number;
  readonly hardCap: number | null;
  readonly throttlePerMinute?: number;
  readonly held: { readonly by: string; readonly reason?: string } | null;
  readonly participants: readonly ParticipantStatus[];
}
export type ApplicationParticipants = Awaited<ReturnType<typeof participantsPresentation>>;
export type ApplicationStatusProjection = Awaited<ReturnType<typeof statusPresentation>>;
export interface SquareApplication {
  join(options?: JoinApplicationOptions, control?: OperationControl): Promise<JoinApplicationResult>;
  express(body: string, options?: ExpressApplicationOptions, control?: OperationControl): Promise<ExpressApplicationResult>;
  catch(options?: CatchOptions, control?: OperationControl): Promise<CatchResult>;
  history(query?: HistoryQuery, control?: OperationControl): Promise<Activity[]>;
  listen(target: string, control?: OperationControl): Promise<ListenerChangeResult>;
  ignore(target: string, control?: OperationControl): Promise<ListenerChangeResult>;
  listening(control?: OperationControl): Promise<readonly string[]>;
  hold(reason?: string, control?: OperationControl): Promise<ExpressResult>;
  resume(control?: OperationControl): Promise<ExpressResult>;
  done(body?: string, control?: OperationControl): Promise<ExpressResult>;
  status(): Promise<ApplicationStatusProjection>;
  participants(): Promise<ApplicationParticipants>;
}

function requireLocation(context: SquareApplicationContext): string {
  const selected = context.squarePath ?? context.env.SQUARE_LOCATION;
  if (selected === undefined || selected.trim() === '') throw new SquareError('invalid_args', 'Square application context needs a square location');
  return path.resolve(context.cwd, selected);
}
async function requireParticipant(context: SquareApplicationContext, squarePath: string, env: NodeJS.ProcessEnv = context.env): Promise<string> {
  const selected = context.participant ?? env.SQUARE_PARTICIPANT_NAME;
  if (selected?.trim()) return selected;
  const discovered = await localParticipantName(squarePath, env).catch(() => undefined);
  if (discovered !== undefined) return discovered;
  throw new SquareError('invalid_args', 'Square application context needs one unambiguous participant name');
}
function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted) throw new SquareError('invalid_args', 'Square operation was cancelled');
}

export function createSquareApplication(context: SquareApplicationContext): SquareApplication {
  const env = { ...context.env };
  const location = () => requireLocation({ ...context, env });
  const hostLedger = context.hostLedger ?? hostLedgerForEnv(env);
  const open = () => Square.at({ path: location(), clock: context.clock, env, hostLedger, wakeTransport: context.wakeTransport });
  async function existing<T>(operation: (participant: Participant) => Promise<T>, control?: OperationControl): Promise<T> {
    checkControl(control);
    const squarePath = location();
    const participantName = await requireParticipant(context, squarePath, env);
    const facade = await openParticipant({ path: squarePath, clock: context.clock, env, hostLedger, wakeTransport: context.wakeTransport }, participantName);
    try { checkControl(control); return await operation(facade.participant); }
    finally { await facade.close(); }
  }
  async function joined<T>(operation: (participant: Participant) => Promise<T>, control?: OperationControl): Promise<T> {
    checkControl(control);
    const square = await open();
    try { return await operation(await square.join(await requireParticipant(context, square.location, env), control)); }
    finally { await square.close(); }
  }
  return {
    async join(options = {}, control = {}) {
      checkControl(control);
      const squarePath = location();
      const square = await open();
      try {
        const participantName = await requireParticipant(context, squarePath, env);
        const before = await square.snapshot();
        const standing = before.participants.some((item) => item.name.toLocaleLowerCase() === participantName.toLocaleLowerCase() && item.state === 'joined');
        const identity = localSessionIdentities(env)[0];
        const owner = standing ? await readParticipantOwner(squarePath, participantName, env).catch(() => undefined) : undefined;
        const reconnect = standing && identity !== undefined && owner?.sessionId === identity.sessionId;
        if (standing && owner !== undefined && identity !== undefined && !options.takeover && !reconnect) {
          throw new SquareError('already_joined', `✕ ${participantName} already stands here — another session holds the name`, { pending: before.participants.length });
        }
        if (options.takeover && standing) {
          const replaced = await square.takeoverWithActivity(participantName, control);
          const activity = replaced.activities.at(-1) ?? null;
          return { participant: replaced.participant.name, activity, kind: 'taken-over', participantCount: (await square.snapshot()).participants.length };
        }
        const joined = await square.joinWithActivity(participantName, control);
        return { participant: joined.participant.name, activity: joined.activity, kind: reconnect ? 'reconnected' : 'joined', participantCount: (await square.snapshot()).participants.length };
      } finally { await square.close(); }
    },
    async express(body, options = {}, control = {}) {
      let waited = false;
      while (true) {
        checkControl(control);
        try {
          const result = await existing((participant) => participant.express(body, options, control), control);
          return { ...result, waited };
        } catch (error) {
          if (!(error instanceof SquareError) || options.noWait || (error.code !== 'held' && error.code !== 'throttled')) throw error;
          waited = true;
          control?.onProgress?.({ kind: 'waiting', reason: error.code, ...(error.code === 'throttled' ? { delayMs: error.facts?.retryAfterMs ?? 1 } : {}) });
          if (error.code === 'throttled') {
            await sleep(error.facts?.retryAfterMs ?? 1, undefined, { signal: control.signal });
          } else {
            const square = await openSquare(location(), { clock: context.clock, env, hostLedger, signal: control.signal });
            try {
              const snapshot = await square.artifact.read(control.signal);
              if (currentHold(snapshot.state.acts).active) await square.artifact.changed(snapshot.version, Infinity, control.signal);
            } finally { await closeOpenSquare(square); }
          }
        }
      }
    },
    catch(options, control) { return existing((participant) => participant.catch(options, control), control); },
    async history(query, control) {
      checkControl(control);
      if (context.participant !== undefined || env.SQUARE_PARTICIPANT_NAME !== undefined) return existing((participant) => participant.history(query, control), control);
      const square = await open();
      try { checkControl(control); return await square.history(query, control); } finally { await square.close(); }
    },
    listen(target, control) { return existing((participant) => participant.listen(target, control), control); },
    ignore(target, control) { return existing((participant) => participant.ignore(target, control), control); },
    listening(control) { return existing((participant) => participant.listening(control), control); },
    hold(reason, control) { return joined((participant) => participant.hold(reason, control), control); },
    resume(control) { return joined((participant) => participant.resume(control), control); },
    async done(body, control) {
      const squarePath = location();
      const participantName = await requireParticipant(context, squarePath, env);
      const identity = localSessionIdentities(env)[0];
      const owner = identity === undefined ? undefined : await readParticipantOwner(squarePath, participantName, env).catch(() => undefined);
      if (identity !== undefined && owner?.sessionId === identity.sessionId && owner.epoch > 0) {
        const square = await open();
        try { return await square.doneOwnedSession(participantName, body ?? '', owner.epoch, control); }
        finally { await square.close(); }
      }
      return joined((participant) => participant.done(body, control), control);
    },
    async status() {
      const square = await openSquare(location(), { clock: context.clock, env, hostLedger, wakeTransport: context.wakeTransport });
      try { return await statusPresentation(square); } finally { await closeOpenSquare(square); }
    },
    async participants() {
      const square = await openSquare(location(), { clock: context.clock, env, hostLedger, wakeTransport: context.wakeTransport });
      try { return await participantsPresentation(square); } finally { await closeOpenSquare(square); }
    },
  };
}

export type { CatchResult, PerceivedActivity };
