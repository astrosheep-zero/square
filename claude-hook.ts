import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { automaticSessionEnd, automaticSessionStart } from './automatic-session.js';
import { PRIVILEGED_HOOK_BUDGET_MS, sweepPrivilegedPending } from './notifications.js';
import type { WakeAdapter } from './delivery.js';

export interface NativeHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
}

export async function runClaudeHookAsync(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let input: unknown;
  try { input = JSON.parse(inputText); } catch { return ''; }
  if (input === null || typeof input !== 'object') return '';
  const value = input as NativeHookInput;
  if (typeof value.session_id !== 'string') return runClaudeHook(inputText, env);
  if (value.hook_event_name === 'SessionStart' || value.hook_event_name === 'SessionResume') {
    const cwd = typeof value.cwd === 'string' ? value.cwd : process.cwd();
    try {
      const context = await automaticSessionStart('claude', value.session_id, cwd, env);
      return context === undefined ? '' : `${JSON.stringify({ hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: context } })}\n`;
    } catch { return ''; }
  }
  if (value.hook_event_name === 'SessionEnd') {
    const cwd = typeof value.cwd === 'string' ? value.cwd : process.cwd();
    try { await automaticSessionEnd('claude', value.session_id, cwd, env); } catch { /* end remains bounded */ }
    return '';
  }
  return runClaudeHook(inputText, env);
}

export async function claudeHookResponse(
  input: NativeHookInput,
  lookup: (sessionId: string, env?: NodeJS.ProcessEnv) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  deliveryAdapters?: WakeAdapter[],
): Promise<object | undefined> {
  const sweepDeadline = Date.now() + PRIVILEGED_HOOK_BUDGET_MS;
  if (typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  if (input.hook_event_name !== 'PostToolBatch') return undefined;
  const response = await presentPendingAtBoundary(
    input.session_id,
    (context) => ({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: context } }),
    lookup,
    env
  );
  await sweepPrivilegedPending(typeof input.cwd === 'string' ? input.cwd : process.cwd(), env, deliveryAdapters, sweepDeadline).catch(() => undefined);
  return response;
}

export async function runClaudeHook(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return '';
  }
  if (input === null || typeof input !== 'object') return '';
  const response = await claudeHookResponse(input as NativeHookInput, sessionInbox, env);
  return response === undefined ? '' : `${JSON.stringify(response)}\n`;
}
