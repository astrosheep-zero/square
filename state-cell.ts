import type { SquareState } from './model.js';

/** Synchronous state transition seam shared by memory and file storage. */
export interface StateCell {
  transact<R>(fn: (state: SquareState, version: number) => { state?: SquareState; result: R }): Promise<R>;
  read(): Promise<{ state: SquareState; version: number }>;
  changed(sinceVersion: number, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}
