import os from 'node:os';
import path from 'node:path';
import { createCodexBoundaryStore } from './packages/agent-delivery/src/codex-boundary.js';
export type { CodexBoundary } from './packages/agent-delivery/src/codex-boundary.js';

export function codexBoundaryStore(env: NodeJS.ProcessEnv = process.env) {
  return createCodexBoundaryStore(env.SQUARE_CODEX_BOUNDARIES || path.join(os.homedir(), '.square', 'codex-boundaries.json'));
}

export const readCodexBoundary = (id: string, env?: NodeJS.ProcessEnv) => codexBoundaryStore(env).read(id);
export const codexQueueEligible = (id: string, env?: NodeJS.ProcessEnv) => codexBoundaryStore(env).queueEligible(id);
export const recordCodexBoundary = (id: string, event: 'Stop' | 'non-stop' | 'start' | 'end', env?: NodeJS.ProcessEnv, signal?: AbortSignal) =>
  codexBoundaryStore(env).record(id, event, signal);
export const clearCodexBoundary = (id: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => codexBoundaryStore(env).clear(id, signal);
