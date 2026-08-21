import type {
  Activity,
  CatchOptions,
  CatchResult,
  ExpressOptions,
  ExpressResult,
  HistoryQuery,
  ParticipantStatus,
  PerceivedActivity,
  SquareSnapshot,
  WakeNotifier,
} from './square-engine.js';

export type SquareSource = { path: string };
export interface OpenOptions { clock?: () => number; notifier?: WakeNotifier }
export interface SquareAtInput extends SquareSource, OpenOptions {}
export interface SquareBuildInput extends SquareSource {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
  clock?: () => number;
  notifier?: WakeNotifier;
}

export interface Participant {
  readonly name: string;
  express(body: string, options?: ExpressOptions): Promise<ExpressResult>;
  catch(options?: CatchOptions): Promise<CatchResult>;
  history(query?: HistoryQuery): Promise<PerceivedActivity[]>;
  hold(reason?: string): Promise<ExpressResult>;
  resume(): Promise<ExpressResult>;
  done(body?: string): Promise<ExpressResult>;
}

export type {
  Activity,
  CatchOptions,
  CatchResult,
  ExpressOptions,
  ExpressResult,
  HistoryQuery,
  ParticipantStatus,
  PerceivedActivity,
  SquareSnapshot,
  WakeNotifier,
};
