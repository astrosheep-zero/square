import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { openFileApplication } from './square-file-adapter.js';
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
  let application;
  try {
    application = await openFileApplication(squarePath);
  } catch (error) {
    process.stderr.write(`! PUBLIC.square unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
  const name = automaticParticipant(provider, sessionId, env);
  const bindings = lookupSession(sessionId);
  const before = await application.entryPresentation(name);
  if (bindings.some((binding) => canonicalSquarePath(binding.squarePath) === canonicalSquarePath(squarePath) && binding.name === name) && before.joined) {
    await application.close();
    return undefined;
  }
  try {
    await application.join(name);
    const channel = provider === 'claude' ? 'claude-code' : provider;
    recordSessionJoin(sessionId, name, squarePath, channel, { ...env, [providerEnv[provider]]: sessionId });
    const after = await application.entryPresentation(name, 10);
    const activity = after.recentActivities.map((event) => renderAmbientEvent(event, name, {
      now: Date.now(),
      preview: 200,
      actNumber: event.kind === 'say' ? after.sayNumbers[event.index] : undefined,
    })).filter(Boolean).join('\n\n');
    return [`You joined the public square as ${name}.`, after.scene, after.context ? `context\n${after.context}` : '', activity ? `recent activity\n${activity}` : ''].filter(Boolean).join('\n\n');
  } finally {
    await application.close();
  }
}

export async function automaticSessionEnd(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const squarePath = publicSquarePath(cwd);
  const channel = provider === 'claude' ? 'claude-code' : provider;
  const binding = lookupSessionBindings(sessionId).find((item) => canonicalSquarePath(item.squarePath) === canonicalSquarePath(squarePath) && item.channel === channel);
  if (binding === undefined || !fs.existsSync(squarePath)) return;
  const application = await openFileApplication(squarePath);
  try {
    if (!(await application.entryPresentation(binding.name)).joined) return;
    await application.done(binding.name);
  } finally {
    await application.close();
  }
  recordSessionDone(sessionId, binding.name, squarePath, channel, env);
}
