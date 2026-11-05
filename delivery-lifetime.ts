import type { DeliveryLedger, HandoffResult } from './delivery-ledger.js';
import { redactCurrentDiagnostic } from './diagnostic-redaction.js';

/** Report late evidence; DeliveryLedger alone owns connection retirement. */
export function retainDeliveryLedger(ledger: DeliveryLedger) {
  const tracked = new WeakSet<NonNullable<HandoffResult['lateSettlement']>>();
  let closing: Promise<void> | undefined;
  const diagnose = (event: string, result?: HandoffResult, detail?: object) => {
    try {
      const diagnostic = redactCurrentDiagnostic({ event, token: result?.token, outcome: result?.outcome, ...detail });
      try { console.warn(diagnostic); }
      catch { process.stderr.write(`${JSON.stringify(diagnostic)}\n`); }
    } catch { /* Closed diagnostic sinks cannot prevent settlement or resource retirement. */ }
  };
  return {
    track(result: HandoffResult): void {
      const handle = result.lateSettlement;
      if (!handle || tracked.has(handle)) return;
      tracked.add(handle);
      void handle.then(late => {
        if (late.persistence.status !== 'recorded')
          diagnose('delivery-late-settlement', result, { lateOutcome: late.outcome, persistence: late.persistence.status });
      }, () => {
        diagnose('delivery-late-settlement-rejected', result);
      });
    },
    close: () => closing ??= ledger.close(),
  };
}
