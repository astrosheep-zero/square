import { hostLedgerRoot } from './host-ledger-root.js';
import path from 'node:path';

import type { SquareState } from './model.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import {
  projectWakeEvidenceFromState,
  wakeIsEligible,
  type WakeEvidence,
  type WakeEvidenceProjection,
} from './square-projections.js';
import type { DeliveryModel } from './delivery.js';

export type { WakeEvidence, WakeEvidenceProjection };
export { wakeIsEligible };

function hostLedgerForEnv(env: NodeJS.ProcessEnv) {
  return createHostLedgerPort({ rootPath: hostLedgerRoot(env) });
}

/** Adapter entry: open the artifact, assemble host ports, and project wake evidence. */
export async function wakeEvidenceProjection(
  squarePath: string,
  now: number,
  env: NodeJS.ProcessEnv,
): Promise<WakeEvidenceProjection> {
  const square = await openSquare(squarePath, { clock: () => now, hostLedger: hostLedgerForEnv(env), env });
  try {
    const { state } = await square.artifact.read();
    return projectWakeEvidenceFromState({ location: squarePath, state, hostLedger: square.hostLedger!, now });
  } finally {
    await closeOpenSquare(square);
  }
}

export function wakeEvidenceProjectionFromState(
  squarePath: string,
  state: SquareState,
  now: number,
  env: NodeJS.ProcessEnv,
  delivery?: DeliveryModel,
): Promise<WakeEvidenceProjection> {
  return projectWakeEvidenceFromState({ location: squarePath, state, hostLedger: hostLedgerForEnv(env), now, delivery });
}

export async function wakeEvidence(
  squarePath: string,
  recipient: string,
  actIndex: number,
  now: number,
  env: NodeJS.ProcessEnv,
): Promise<WakeEvidence> {
  return (await wakeEvidenceProjection(squarePath, now, env)).evidence(recipient, actIndex);
}
