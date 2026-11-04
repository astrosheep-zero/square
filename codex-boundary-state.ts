import os from 'node:os';
import path from 'node:path';
import { createCodexBoundaryStore } from './packages/agent-delivery/src/codex-boundary.js';
export type { CodexBoundary, CodexStopEpoch } from './packages/agent-delivery/src/codex-boundary.js';

export function codexBoundaryStore(env: NodeJS.ProcessEnv = process.env) {
  return createCodexBoundaryStore(env.SQUARE_CODEX_BOUNDARIES || path.join(os.homedir(), '.square', 'codex-boundaries.json'));
}
