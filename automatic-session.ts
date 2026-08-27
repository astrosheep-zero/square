import { promises as fs } from 'node:fs';
import path from 'node:path';

import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { Square } from './square-wiring.js';
import { entryPresentation } from './views.js';
import { canonicalSquarePath, lookupSessionBindings, recordSessionDone, recordSessionJoin } from './registry.js';
import { automaticParticipant } from './participant-identity.js';

export type AutomaticProvider = 'codex' | 'claude' | 'opencode' | 'pi';

export { automaticParticipant } from './participant-identity.js';

const providerEnv: Record<AutomaticProvider, string> = {
  codex: 'CODEX_THREAD_ID',
  claude: 'CLAUDE_CODE_SESSION_ID',
  opencode: 'OPENCODE_SESSION_ID',
  pi: 'SQUARE_PI_SESSION_ID',
};

export function publicSquarePath(cwd: string): string {
  return path.join(cwd, '.square', 'PUBLIC.square');
}

async function squareExists(squarePath: string): Promise<boolean> {
  try {
    await fs.access(squarePath);
    return true;
  } catch {
    return false;
  }
}

export async function automaticSessionStart(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const squarePath = publicSquarePath(cwd);
  if (!await squareExists(squarePath)) return undefined;
  let reader;
  try {
    reader = await openSquare(squarePath);
  } catch (error) {
    process.stderr.write(`! PUBLIC.square unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
  const name = automaticParticipant(provider, sessionId, env);
  const canonicalPath = await canonicalSquarePath(squarePath);
  const alreadyBound = (await lookupSessionBindings(sessionId, Date.now(), env)).some((binding) =>
    binding.squarePath === canonicalPath && binding.name === name
  );
  await closeOpenSquare(reader);
  const square = await Square.at({ path: squarePath });
  try {
    const implicit = await square.implicitJoin(name);
    if (implicit.state === 'done' || (implicit.state === 'active' && alreadyBound)) return undefined;
    const channel = provider === 'claude' ? 'claude-code' : provider;
    await recordSessionJoin(sessionId, name, squarePath, channel, { ...env, [providerEnv[provider]]: sessionId });
    return undefined;
  } finally {
    await square.close();
  }
}

export async function automaticSessionEnd(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const squarePath = publicSquarePath(cwd);
  const channel = provider === 'claude' ? 'claude-code' : provider;
  const canonicalPath = await canonicalSquarePath(squarePath);
  const binding = (await lookupSessionBindings(sessionId, Date.now(), env)).find((item) => item.squarePath === canonicalPath && item.channel === channel);
  if (binding === undefined || !await squareExists(squarePath)) return;
  const reader = await openSquare(squarePath);
  const joined = await entryPresentation(reader, binding.name).finally(() => closeOpenSquare(reader));
  if (!joined.joined) return;
  const square = await Square.at({ path: squarePath });
  try {
    const participant = await square.join(binding.name);
    await participant.done();
  } finally {
    await square.close();
  }
  await recordSessionDone(sessionId, binding.name, squarePath, channel, env);
}
