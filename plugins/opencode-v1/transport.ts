import { randomInt, createHash } from 'node:crypto';
import { renderDeliveryReminder } from '../../delivery-frame.js';
import type { DeliveryTransport } from '../../delivery-ledger.js';

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
  return {
    kind: 'opencode-server',
    async send(card, address, context) {
      const signal = AbortSignal.any([lifetime, context.signal]);
      if (address.sessionId !== sessionId || signal.aborted) return 'not-capable';
      const messageId = nativeMessageId();
      const text = renderDeliveryReminder([card.text], { tagged: true });
      const payloadHash = createHash('sha256').update(text).digest('hex');
      if (!await context.prepare({ token: context.token, messageId, payloadHash }) || signal.aborted
        || !await context.beforeSend() || signal.aborted || Date.now() >= context.deadline) return 'not-capable';
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
    },
  };
}
