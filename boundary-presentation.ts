import { DeliveryLedger } from './delivery-ledger.js';
import type { Owner } from './owner.js';

const CONTEXT_MAX = 1200;

/** The sink must resolve only after the host has actually accepted the output. */
export async function presentPendingAtBoundary<T>(
  owner: Owner,
  present: (context: string) => T | Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  try {
    const session = await ledger.session(owner);
    if (!session || session.state !== 'attached' || signal?.aborted) return undefined;
    const claim = await ledger.claimPresentation(owner, { generation: session.generation, budgetChars: CONTEXT_MAX, signal });
    if (!claim) return undefined;
    let current: boolean;
    try { current = await claim.current(signal); }
    catch (error) { await claim.settle('released'); throw error; }
    if (!current || signal?.aborted) {
      await claim.settle('released');
      return undefined;
    }
    let result: T;
    try { result = await present(claim.text); }
    catch (error) { await claim.settle('unknown'); throw error; }
    await claim.settle('presented');
    return result;
  } finally { await ledger.close(); }
}
