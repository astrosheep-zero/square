import { DeliveryLedger } from './delivery-ledger.js';
import { truncateChars } from './neutral.js';
import type { Owner } from './owner.js';

const warning = 'This is an external notification, not a direct message from the user.';

/** Receivers frame finished cards; card text and its whitespace stay verbatim. */
export function renderDeliveryReminder(texts: readonly string[], options: { tagged: boolean }): string {
  if (!texts.length) return '';
  const text = `${warning}\n\n${texts.join('\n\n')}`;
  return options.tagged ? `<system-reminder>\n${text}\n</system-reminder>` : text;
}

export function deliveryFrameOverhead(options: { tagged: boolean }): number {
  return renderDeliveryReminder([''], options).length;
}

const EXTERNAL_DIAGNOSTIC_MAX_CHARS = 160;

export function truncateExternalDiagnostic(diagnostic: string): string {
  if (truncateChars(diagnostic, EXTERNAL_DIAGNOSTIC_MAX_CHARS).remaining === 0) return diagnostic;
  return `${truncateChars(diagnostic, EXTERNAL_DIAGNOSTIC_MAX_CHARS - 1).text}…`;
}

const CONTEXT_MAX = 1200;

/** The sink must resolve only after the host has actually accepted the output. */
export async function presentPendingAtBoundary<T>(
  owner: Owner,
  present: (context: string) => T | Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY, signal });
  try {
    const session = await ledger.session(owner, signal);
    if (!session || session.state !== 'attached' || signal?.aborted) return undefined;
    const claim = await ledger.claimPresentation(owner, { generation: session.generation, budgetChars: CONTEXT_MAX - deliveryFrameOverhead({ tagged: true }), signal });
    if (!claim) return undefined;
    let current: boolean;
    try { current = await claim.current(signal); }
    catch (error) { await claim.settle('released'); throw error; }
    if (!current || signal?.aborted) {
      await claim.settle('released');
      return undefined;
    }
    let result: T;
    try { result = await present(renderDeliveryReminder(claim.cards.map(card => card.text), { tagged: true })); }
    catch (error) { await claim.settle('unknown'); throw error; }
    await claim.settle('presented');
    return result;
  } finally { await ledger.close(); }
}
