import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { Square } from './square-wiring.js';
import { entryPresentation } from './views.js';
import { canonicalSquarePath, lookupSession, lookupSessionBindings, recordSessionDone, recordSessionJoin } from './registry.js';
import { renderAmbientEvent } from './presentation.js';
import { validateName } from './model.js';

export type AutomaticProvider = 'codex' | 'claude' | 'opencode' | 'pi';

const providerEnv: Record<AutomaticProvider, string> = {
  codex: 'CODEX_THREAD_ID',
  claude: 'CLAUDE_CODE_SESSION_ID',
  opencode: 'OPENCODE_SESSION_ID',
  pi: 'SQUARE_PI_SESSION_ID',
};

export function publicSquarePath(cwd: string): string {
  return path.join(cwd, '.square', 'PUBLIC.square');
}

export function automaticParticipant(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv): string {
  const configured = env.SQUARE_PARTICIPANT_NAME?.trim();
  if (configured) {
    validateName(configured);
    return configured;
  }
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 12);
  return `${provider}-${digest}`;
}

export async function automaticSessionStart(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const squarePath = publicSquarePath(cwd);
  if (!fs.existsSync(squarePath)) return undefined;
  let reader;
  try {
    reader = await openSquare(squarePath);
  } catch (error) {
    process.stderr.write(`! PUBLIC.square unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
  const name = automaticParticipant(provider, sessionId, env);
  const bindings = lookupSession(sessionId);
  const before = await entryPresentation(reader, name);
  if (bindings.some((binding) => canonicalSquarePath(binding.squarePath) === canonicalSquarePath(squarePath) && binding.name === name) && before.joined) {
    await closeOpenSquare(reader);
    return undefined;
  }
  await closeOpenSquare(reader);
  const square = await Square.at({ path: squarePath });
  try {
    await square.join(name);
    const channel = provider === 'claude' ? 'claude-code' : provider;
    recordSessionJoin(sessionId, name, squarePath, channel, { ...env, [providerEnv[provider]]: sessionId });
    const afterSquare = await openSquare(squarePath);
    const after = await entryPresentation(afterSquare, name, 10).finally(() => closeOpenSquare(afterSquare));
    const activity = after.recentActivities.map((event) => renderAmbientEvent(event, name, {
      now: Date.now(),
      preview: 200,
      actNumber: event.kind === 'say' ? after.sayNumbers[event.index] : undefined,
    })).filter(Boolean).join('\n\n');
    return [`You joined the public square as ${name}.`, after.scene, after.context ? `context\n${after.context}` : '', activity ? `recent activity\n${activity}` : ''].filter(Boolean).join('\n\n');
  } finally {
    await square.close();
  }
}

export async function automaticSessionEnd(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const squarePath = publicSquarePath(cwd);
  const channel = provider === 'claude' ? 'claude-code' : provider;
  const binding = lookupSessionBindings(sessionId).find((item) => canonicalSquarePath(item.squarePath) === canonicalSquarePath(squarePath) && item.channel === channel);
  if (binding === undefined || !fs.existsSync(squarePath)) return;
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
  recordSessionDone(sessionId, binding.name, squarePath, channel, env);
}
