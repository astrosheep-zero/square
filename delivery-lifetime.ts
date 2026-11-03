import type { DeliveryLedger, HandoffResult } from './delivery-ledger.js';
import { redactCurrentDiagnostic } from './diagnostic-redaction.js';

/** Retire the caller's connection without abandoning an already-invoked effect. */
export function retainDeliveryLedger(ledger: DeliveryLedger) {
  const pending = new Set<NonNullable<HandoffResult['lateSettlement']>>();
  let retired = false, closing: Promise<void> | undefined;
  const diagnose = (event: string, result?: HandoffResult, detail?: object) => {
    try {
      const diagnostic = redactCurrentDiagnostic({ event, token: result?.token, outcome: result?.outcome, ...detail });
      try { console.warn(diagnostic); }
      catch { process.stderr.write(`${JSON.stringify(diagnostic)}\n`); }
    } catch { /* Closed diagnostic sinks cannot prevent settlement or resource retirement. */ }
  };
  const closeOnce = () => closing ??= ledger.close();
  const settled = (handle: NonNullable<HandoffResult['lateSettlement']>) => {
    pending.delete(handle);
    if (retired && !pending.size)
      void closeOnce().catch(() => diagnose('delivery-ledger-deferred-close-error'));
  };
  return {
    track(result: HandoffResult): void {
      const handle = result.lateSettlement;
      if (!handle || pending.has(handle)) return;
      pending.add(handle);
      void handle.then(late => {
        if (late.persistence.status !== 'recorded')
          diagnose('delivery-late-settlement', result, { lateOutcome: late.outcome, persistence: late.persistence.status });
        settled(handle);
      }, () => {
        diagnose('delivery-late-settlement-rejected', result);
        settled(handle);
      });
    },
    async close(): Promise<void> {
      retired = true;
      if (!pending.size) await closeOnce();
    },
  };
}
