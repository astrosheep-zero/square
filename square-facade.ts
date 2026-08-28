import type { ActivityId, Perception, Reach } from './square-core.js';
import type { HostLedgerPort, WakeTransportPort } from './ports.js';

export interface Activity { readonly id: ActivityId; readonly at: number; readonly kind: 'join' | 'say' | 'done' | 'hold' | 'resume' | 'listen' | 'ignore'; readonly actor: string; readonly body?: string; readonly mentions: readonly string[]; readonly target?: string; readonly reply?: ActivityId; }
export interface PerceivedActivity extends Activity { readonly perception: Perception; }
export interface ExpressOptions { readonly force?: boolean; readonly reach?: Reach; readonly reply?: ActivityId; }
export interface ExpressResult { readonly activity: Activity; }
export interface ListenerChangeResult { readonly activity: Activity | null; }
export interface CatchOptions { readonly idle?: number; readonly from?: readonly string[]; readonly mention?: boolean; }
export interface CatchResult { readonly activities: readonly PerceivedActivity[]; readonly consumedThrough: ActivityId | null; readonly idleExpired: boolean; }
export interface HistoryQuery { readonly limit?: number; readonly order?: 'asc' | 'desc'; readonly before?: ActivityId; readonly after?: ActivityId; readonly grep?: string; readonly from?: readonly string[]; readonly mention?: boolean; }
export interface ParticipantStatus { readonly name: string; readonly state: 'joined' | 'done'; readonly consumedThrough: ActivityId | null; readonly watching: boolean; readonly listening: readonly string[]; }
export interface SquareSnapshot { readonly context: string; readonly actCount: number; readonly hardCap: number | null; readonly throttlePerMinute?: number; readonly held: { readonly by: string; readonly reason?: string } | null; readonly participants: readonly ParticipantStatus[]; delivered(name: string, id: ActivityId): boolean; }

export type SquareSource = { path: string };
export interface OpenOptions { clock?: () => number; hostLedger?: HostLedgerPort; wakeTransport?: WakeTransportPort; env?: NodeJS.ProcessEnv }
export interface SquareAtInput extends SquareSource, OpenOptions {}
export interface SquareBuildInput extends SquareSource {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
  clock?: () => number;
  hostLedger?: HostLedgerPort;
  wakeTransport?: WakeTransportPort;
  env?: NodeJS.ProcessEnv;
}

export interface Participant {
  readonly name: string;
  express(body: string, options?: ExpressOptions): Promise<ExpressResult>;
  listen(target: string): Promise<ListenerChangeResult>;
  ignore(target: string): Promise<ListenerChangeResult>;
  listening(): Promise<readonly string[]>;
  catch(options?: CatchOptions): Promise<CatchResult>;
  history(query?: HistoryQuery): Promise<PerceivedActivity[]>;
  hold(reason?: string): Promise<ExpressResult>;
  resume(): Promise<ExpressResult>;
  done(body?: string): Promise<ExpressResult>;
}
