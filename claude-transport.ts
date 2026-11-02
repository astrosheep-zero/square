import { stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { WakeRoute } from './channel-values.js';
import type { WakeOutcome, WakeRequest, WakeTransportPort } from './channel-transport.js';
import { writeClaudeNative } from './packages/agent-delivery/src/claude-native.js';
const marker = /(?:^|\n)\[square-inbox:([a-zA-Z0-9-]+)\](?:\n|$)/g;
export function nativeTokens(text: string): string[] { return [...text.matchAll(marker)].map((match) => match[1]!); }
export function nativePayload(token: string, preview: string): string { return `[square-inbox:${token}]\n${preview}\n[/square-inbox:${token}]`; }
function nativeSupported(route: WakeRoute): boolean { return route.address.loaded === 'true' && !!route.address.endpoint; }
export function hashPayload(payload: string): string { return createHash('sha256').update(payload).digest('hex'); }

async function preview(request: WakeRequest): Promise<NonNullable<WakeRequest['presentation']> | undefined> {
  return request.presentation;
}

async function writeClaudeWake(sessionId: string, endpoint: string, messageId: string, payload: string, timeoutMs: number, signal: AbortSignal): Promise<WakeOutcome> {
  const result = await writeClaudeNative({ sessionId, endpoint, messageId }, payload, { deadline: Date.now() + timeoutMs, signal });
  if (result.outcome === 'unavailable') return { outcome: 'failed', signature: 'claude_endpoint_unavailable', message: result.message };
  return { outcome: 'unknown', signature: 'native_admission_unconfirmed', message: result.outcome === 'written' ? 'Claude accepted the local write; native admission is unconfirmed.' : result.message };
}

export function createClaudeWakeTransport(env: NodeJS.ProcessEnv = process.env): WakeTransportPort {
  return {
    async probe(route) {
      if (!nativeSupported(route)) return { outcome: 'not-capable', diagnostic: 'Claude native inbox unavailable: a loaded interactive Square mod is required.' };
      try { return (await stat(route.address.endpoint!)).isSocket() || { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint is not a socket.' }; }
      catch { return { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint unavailable.' }; }
    },
    attempt: (request, timeoutMs, beforeSend) => dispatchClaude(request, timeoutMs, beforeSend, env),
  };
}

async function dispatchClaude(request: WakeRequest, timeoutMs: number, beforeSend: () => Promise<boolean>, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome> {
  void env;
  const signal = AbortSignal.timeout(timeoutMs);
  if (!nativeSupported(request.route) || request.claimToken === undefined)
    return { outcome: 'not-capable', diagnostic: 'Claude native delivery needs a current artifact claim and loaded inbox.' };
  if (signal.aborted || !await beforeSend())
    return { outcome: 'unknown', signature: 'native_send_suppressed' };
  const prepared = await preview(request);
  if (prepared === undefined) return { outcome: 'not-capable', diagnostic: 'Claude activity is no longer current.' };
  const messageId = randomUUID();
  const payload = nativePayload(request.claimToken, prepared.payload);
  const correlation = { harness: 'claude' as const, token: request.claimToken, messageId, payloadHash: hashPayload(payload) };
  if (!await request.channel.prepare({ correlation, coverage: prepared.coverage,
    ...(prepared.description === undefined ? {} : { description: prepared.description }) }))
    return { outcome: 'not-capable', diagnostic: 'Claude delivery claim is no longer current.' };
  const fresh = await preview(request);
  if (fresh === undefined || nativePayload(request.claimToken, fresh.payload) !== payload)
    return { outcome: 'not-capable', diagnostic: 'Claude activity changed before native write.' };
  if (signal.aborted || !await beforeSend()) return { outcome: 'not-capable', diagnostic: 'Claude activity was consumed before native write.' };
  const sessionId = request.route.address.sessionId;
  if (sessionId === undefined) return { outcome: 'not-capable', diagnostic: 'Claude native route has no session address.' };
  return writeClaudeWake(sessionId, request.route.address.endpoint!, messageId, payload, timeoutMs, signal);
}

