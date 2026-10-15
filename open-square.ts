import { createArtifactPort, createSquare, prepareSquareBuild } from './artifact.js';
import { InternalSquareError, SquareError } from './model.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import type { HostLedgerPort, SquareArtifactPort, WakeTransportPort } from './ports.js';
import type { OperationControl } from './square-facade.js';

/** Host-bound resource: artifact, captured environment, clock, ledger and transport. */
export interface OpenSquare {
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly location: string;
  readonly hostLedger?: HostLedgerPort;
  readonly wakeTransport?: WakeTransportPort;
  readonly env?: NodeJS.ProcessEnv;
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

export async function openSquare(
  squarePath: string,
  options: Pick<SquareBuildOptions, 'clock' | 'hostLedger' | 'wakeTransport' | 'env' | 'signal'> = {},
  control?: OperationControl,
): Promise<OpenSquare> {
  const env = { ...(options.env ?? process.env) };
  const artifact = createArtifactPort(squarePath, undefined, options.signal);
  try {
    await artifact.read(facts => facts.header(), control?.signal);
    return {
      artifact, clock: options.clock ?? Date.now, location: squarePath, env,
      hostLedger: options.hostLedger ?? createHostLedgerPort({ rootPath: hostLedgerRoot(env) }),
      wakeTransport: options.wakeTransport,
    };
  } catch (error) {
    await artifact.close();
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
  };
}

export function closeOpenSquare(square: OpenSquare): Promise<void> {
  return square.artifact.close();
}
