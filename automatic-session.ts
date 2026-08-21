import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadSquare } from './artifact.js';
import { openFileApplication } from './square-file-adapter.js';
import { canonicalSquarePath, lookupSession, lookupSessionBindings, recordSessionDone, recordSessionJoin } from './registry.js';
import { isCurrentlyJoined } from './runtime.js';
import { renderPublicTail } from './presentation.js';
import { type SquareDoc, validateName } from './model.js';

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
  let doc: SquareDoc;
  try {
    doc = loadSquare(squarePath);
  } catch (error) {
    process.stderr.write(`! PUBLIC.square unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
  const name = automaticParticipant(provider, sessionId, env);
  const bindings = lookupSession(sessionId);
  if (bindings.some((binding) => canonicalSquarePath(binding.squarePath) === canonicalSquarePath(squarePath) && binding.name === name && isCurrentlyJoined(doc.acts, name))) {
    return undefined;
  }
  const application = await openFileApplication(squarePath);
  try {
    await application.join(name);
  } finally {
    await application.close();
  }
  const channel = provider === 'claude' ? 'claude-code' : provider;
  recordSessionJoin(sessionId, name, squarePath, channel, { ...env, [providerEnv[provider]]: sessionId });
  const after = loadSquare(squarePath);
  const scene = after.warmup.join('\n').trim();
  const context = after.preamble.join('\n').trim();
  const activity = renderPublicTail(after.acts, 10, Date.now(), name);
  return [`You joined the public square as ${name}.`, scene, context ? `context\n${context}` : '', activity ? `recent activity\n${activity}` : ''].filter(Boolean).join('\n\n');
}

export async function automaticSessionEnd(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const squarePath = publicSquarePath(cwd);
  const channel = provider === 'claude' ? 'claude-code' : provider;
  const binding = lookupSessionBindings(sessionId).find((item) => canonicalSquarePath(item.squarePath) === canonicalSquarePath(squarePath) && item.channel === channel);
  if (binding === undefined || !fs.existsSync(squarePath)) return;
  const doc = loadSquare(squarePath);
  if (!isCurrentlyJoined(doc.acts, binding.name)) return;
  const application = await openFileApplication(squarePath);
  try {
    await application.done(binding.name);
  } finally {
    await application.close();
  }
  recordSessionDone(sessionId, binding.name, squarePath, channel, env);
}
