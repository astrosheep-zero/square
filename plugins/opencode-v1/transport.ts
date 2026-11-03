import { randomInt } from 'node:crypto';
import { prepareOpenCodeWake } from '../opencode-shared/delivery.js';
import type { WakeTransportPort } from '../../ports.js';

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

export function legacyTransport(client: Client, sessionId: string, lifetime: AbortSignal): WakeTransportPort {
  return {
    probe: async route => !lifetime.aborted && route.kind === 'opencode-server' && route.address.sessionId === sessionId,
    async attempt(request, timeoutMs, beforeSend) {
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs)]);
      const prepared = await prepareOpenCodeWake(request, sessionId, signal, beforeSend, nativeMessageId);
      if (!prepared || signal.aborted) return { outcome: 'not-capable', diagnostic: 'OpenCode attention is no longer current.' };
      let onAbort: (() => void) | undefined;
      try {
        const response = await Promise.race([
          client.session.promptAsync({ path: { id: sessionId }, body: { messageID: prepared.inputId, parts: [{ type: 'text', text: prepared.payload }] }, signal }),
          new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); }),
        ]);
        return { outcome: 'unknown', signature: response.error ? 'native-error' : response.response?.status === 204 ? 'submitted' : 'native-response' };
      } catch { return { outcome: 'unknown', signature: 'native-error-or-timeout' }; }
      finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    },
  };
}
