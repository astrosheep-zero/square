import type { SqliteSquare } from './sqlite-square.js';

/** Structural resource contract extracted from the existing implementation.
 * Backends implement the actual resource, not a second operation/policy dispatcher.
 * Host-internal methods may explicitly refuse where their capabilities do not exist. */
export interface SquareBackend extends Pick<SqliteSquare, keyof SqliteSquare> {}

export interface StdioBackendConfiguration {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}
export type SquareBackends = Readonly<Record<string, StdioBackendConfiguration>>;
