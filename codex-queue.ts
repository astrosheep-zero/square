import { connect, DeliveryError } from './packages/agent-delivery/src/index.js';
import { codexQueueEndpoint } from './packages/agent-delivery/src/codex-endpoint.js';

/** Receiver-owned wake admission, never a card handoff or presentation receipt.
 * The native queue may outlive its pending cards; UserPromptSubmit fetches the
 * current body only when the queued turn actually starts. */
export async function queueCodexWake(address: Readonly<Record<string, string>>, beforeSend: () => Promise<boolean>,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<'accepted' | 'not-capable' | 'unknown'> {
  const deadline = Date.now() + 5000;
  try {
    const endpoint = address.endpoint ?? codexQueueEndpoint({ CODEX_HOME: address.codexHome });
    const agent = await connect({ harness: 'codex', transport: 'cli', sessionId: address.threadId,
      boundaries: { queueEligible: async () => await beforeSend() && !signal.aborted && Date.now() < deadline },
      env, bin: env.SQUARE_CODEX_BIN, codexHome: address.codexHome, endpoint });
    if (signal.aborted || Date.now() >= deadline) return 'not-capable';
    await agent.queue('Square wake: use only the current external notification context supplied for this turn. If none is supplied, this wake is obsolete; do not repeat earlier work.',
      { timeoutMs: deadline - Date.now(), signal });
    return 'accepted';
  } catch (error) {
    return error instanceof DeliveryError && !error.maybeDelivered ? 'not-capable' : 'unknown';
  }
}
