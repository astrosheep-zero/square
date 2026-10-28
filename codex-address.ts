import { resolveCodexHome } from './packages/agent-delivery/src/codex-endpoint.js';
import type { WakeAddress } from './model.js';

/** Capture the receiver's CLI configuration when its seat is established, not at send time. */
export function codexWakeAddress(threadId: string, env: NodeJS.ProcessEnv): WakeAddress {
  const endpoint = env.SQUARE_CODEX_ENDPOINT?.trim();
  return { kind: 'codex-queue', address: {
    threadId, codexHome: resolveCodexHome(env), ...(endpoint ? { endpoint } : {}),
  } };
}
