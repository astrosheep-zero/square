import { randomInt } from 'node:crypto';
import type { DeliveryTransport } from '../../ledger/delivery-ledger.js';
import { openCodeTransport } from '../opencode-shared/delivery.js';

type Client = { session: { promptAsync(input: unknown): Promise<{ error?: unknown; response?: Response }> } };
let lastTime = 0, counter = 0;
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** OpenCode's 48-bit timestamp/counter prefix followed by 14 random base62 digits. */
export function nativeMessageId(): string {
  const now = Math.max(Date.now(), lastTime);
  counter = now === lastTime ? counter + 1 : 0;
  if (counter >= 0x1000) { lastTime = now + 1; counter = 0; } else lastTime = now;
  const prefix = (BigInt(lastTime) * 0x1000n + BigInt(counter)).toString(16).slice(-12).padStart(12, '0');
  return `msg_${prefix}${Array.from({ length: 14 }, () => alphabet[randomInt(62)]).join('')}`;
}

export function legacyTransport(client: Client, sessionId: string, lifetime: AbortSignal): DeliveryTransport {
  return openCodeTransport(sessionId, lifetime, nativeMessageId, async ({ messageId, text, signal }) => {
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        client.session.promptAsync({ path: { id: sessionId }, body: { messageID: messageId, parts: [{ type: 'text', text }] }, signal }),
        new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); }),
      ]);
      // promptAsync acknowledges only submission, not native acceptance or presentation.
      return 'unknown';
    } catch { return 'unknown'; }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  });
}
