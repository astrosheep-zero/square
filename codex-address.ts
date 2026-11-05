import { resolveCodexHome } from './packages/agent-delivery/src/codex-endpoint.js';
import { createCodexBoundaryStore, type CodexBoundaryStore } from './packages/agent-delivery/src/codex-boundary.js';
import type { DeliveryRoute } from './delivery-ledger.js';
import os from 'node:os';
import path from 'node:path';

/** Local Stop/activity epochs shared by native hooks and async watchers. No RPC. */
export function codexBoundaryStore(env: NodeJS.ProcessEnv): CodexBoundaryStore {
  return createCodexBoundaryStore(env.SQUARE_CODEX_BOUNDARIES ?? path.join(os.homedir(), '.square', 'codex-boundaries.json'));
}

/** Capture the receiver's CLI configuration when its seat is established, not at send time. */
export function codexWakeAddress(threadId: string, env: NodeJS.ProcessEnv): DeliveryRoute {
  const endpoint = env.SQUARE_CODEX_ENDPOINT?.trim();
  return { kind: 'codex-queue', address: {
    threadId, codexHome: resolveCodexHome(env), ...(endpoint ? { endpoint } : {}),
  } };
}
