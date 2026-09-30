import path from 'node:path';
import { homedir } from 'node:os';

/** Resolve the single user-level host ledger root. */
export function hostLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_HOST_LEDGER_ROOT
    ?? (env.SQUARE_REGISTRY === undefined
      ? path.join(homedir(), '.square', 'host-ledger')
      : path.dirname(env.SQUARE_REGISTRY));
}
