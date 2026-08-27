import os from 'node:os';
import path from 'node:path';
import { canonicalSquarePath } from './registry.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import { formatActivityId } from './square-core.js';
import { projectPresentationEvidence } from './application.js';

export function presentedPath(env: NodeJS.ProcessEnv = process.env): string { return env.SQUARE_PRESENTED || path.join(os.homedir(), '.square', 'presented.ndjsonl'); }
function evidence(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createHostLedgerPort> { const file = presentedPath(env); return createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER ?? path.dirname(file), writableScope: 'user', readableScopes: ['user'] }); }
export async function hasPresentedForOwner(sessionId: string, squarePath: string, name: string, actIndex: number, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<boolean> { const resolved = await canonicalSquarePath(squarePath); return (await projectPresentationEvidence({ hostLedger: evidence(env), now, location: resolved, participant: name, sessionId, activity: formatActivityId(actIndex) })).some((row) => row.outcome === 'presented'); }
