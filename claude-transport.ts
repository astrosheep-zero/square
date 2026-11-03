import { stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { renderDeliveryReminder } from './delivery-frame.js';
import type { DeliveryTransport } from './delivery-ledger.js';
import { writeClaudeNative } from './packages/agent-delivery/src/claude-native.js';

const marker = /(?:^|\n)\[square-inbox:([a-zA-Z0-9-]+)\](?:\n|$)/g;
export function nativeTokens(text: string): string[] { return [...text.matchAll(marker)].map(match => match[1]!); }
export function nativePayload(token: string, text: string): string {
  return renderDeliveryReminder([`[square-inbox:${token}]\n${text}\n[/square-inbox:${token}]`], { tagged: false });
}
export function hashPayload(payload: string): string { return createHash('sha256').update(payload).digest('hex'); }

export function createClaudeWakeTransport(env: NodeJS.ProcessEnv = process.env): DeliveryTransport {
  return {
    kind: 'claude-native',
    async send(card, address, context) {
      if (address.loaded !== 'true' || !address.endpoint || !address.sessionId) return 'not-capable';
      try { if (!(await stat(address.endpoint)).isSocket()) return 'not-capable'; } catch { return 'not-capable'; }
      const messageId = randomUUID();
      const payload = nativePayload(context.token, card.text);
      if (!await context.prepare({ token: context.token, messageId, payloadHash: hashPayload(payload) })) return 'not-capable';
      if (context.signal.aborted || Date.now() >= context.deadline) return 'not-capable';
      const result = await writeClaudeNative({ sessionId: address.sessionId, endpoint: address.endpoint, messageId, env }, payload,
        { deadline: context.deadline, signal: context.signal, beforeSend: context.beforeSend });
      return result.outcome === 'unavailable' ? 'failed' : 'unknown';
    },
  };
}
