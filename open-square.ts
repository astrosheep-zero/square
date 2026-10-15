import path from 'node:path';
import { createArtifactPort, createSquare, prepareSquareBuild } from './artifact.js';
import { InternalSquareError, SquareError } from './model.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import type { HostLedgerPort, SquareArtifactPort, SquareResourceOwner, WakeTransportPort } from './ports.js';
import type { OperationControl } from './square-facade.js';

/** Host-bound resource: artifact, captured environment, clock, ledger and transport. */
export interface OpenSquare {
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly location: string;
  readonly hostLedger?: HostLedgerPort;
  readonly wakeTransport?: WakeTransportPort;
  readonly env?: NodeJS.ProcessEnv;
  /** False when a long-lived owner lent the connection; closing this view leaves it open. */
  readonly ownsArtifact: boolean;
}
export interface SquareBuildOptions {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
  clock?: () => number;
  hostLedger?: HostLedgerPort;
  wakeTransport?: WakeTransportPort;
  env?: NodeJS.ProcessEnv;
  /** One caller deadline propagated into artifact busy retries. */
  signal?: AbortSignal;
}

export interface SquareOpenOptions extends Pick<SquareBuildOptions, 'clock' | 'hostLedger' | 'wakeTransport' | 'env' | 'signal'> {
  /** A caller-owned connection to reuse; this view never closes it. */
  readonly artifact?: SquareArtifactPort;
}

export async function openSquare(
  squarePath: string,
  options: SquareOpenOptions = {},
  control?: OperationControl,
): Promise<OpenSquare> {
  const env = { ...(options.env ?? process.env) };
  const borrowed = options.artifact;
  // A borrowed connection was opened by its owner without a request signal; this
  // request may only abort its own read, never the shared connection's lifetime.
  const artifact = borrowed ?? createArtifactPort(squarePath, undefined, options.signal);
  try {
    await artifact.read(facts => facts.header(), control?.signal);
    return {
      artifact, clock: options.clock ?? Date.now, location: squarePath, env, ownsArtifact: borrowed === undefined,
      hostLedger: options.hostLedger ?? createHostLedgerPort({ rootPath: hostLedgerRoot(env) }),
      wakeTransport: options.wakeTransport,
    };
  } catch (error) {
    if (borrowed === undefined) await artifact.close();
    if (error instanceof InternalSquareError && error.code === 'not_found')
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    throw error;
  }
}

export async function buildSquare(squarePath: string, options: SquareBuildOptions): Promise<OpenSquare> {
  try {
    await createSquare(squarePath, { ...options, force: false }, options.markdown, options.signal);
  } catch (error) {
    if (error instanceof InternalSquareError && error.code === 'conflict')
      throw new SquareError('io', `Cannot build over an existing square at ${squarePath}`);
    throw error;
  }
  return openSquare(squarePath, { ...options, signal: undefined });
}

export function buildMemorySquare(options: SquareBuildOptions): OpenSquare {
  return {
    artifact: createArtifactPort(':memory:', prepareSquareBuild(options, options.markdown)),
    clock: options.clock ?? Date.now, location: 'memory',
    hostLedger: options.hostLedger, wakeTransport: options.wakeTransport,
    ownsArtifact: true,
  };
}

export function closeOpenSquare(square: OpenSquare): Promise<void> {
  // A borrowed connection belongs to its owner; only owned views close it here.
  return square.ownsArtifact === false ? Promise.resolve() : square.artifact.close();
}

/** Explicit-lifetime holder of one reused artifact connection. The first request
 * binds the location; a request for any other location is refused instead of
 * silently sharing the wrong square. The owner closes the connection once. */
export function createSquareResourceOwner(): SquareResourceOwner {
  let held: { readonly location: string; readonly artifact: SquareArtifactPort } | undefined;
  let closed = false;
  return {
    artifact(location: string): SquareArtifactPort {
      if (closed) throw new SquareError('unavailable', 'Square resource owner is closed');
      const key = path.resolve(location);
      if (held === undefined) {
        // No external signal: a request must never become the shared connection's lifetime.
        held = { location: key, artifact: createArtifactPort(key) };
      }
      if (held.location !== key) {
        throw new SquareError('unavailable',
          `Square resource owner already holds ${held.location}; it cannot also open ${key}`);
      }
      return held.artifact;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const artifact = held?.artifact;
      held = undefined;
      if (artifact !== undefined) await artifact.close();
    },
  };
}
