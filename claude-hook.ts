import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { automaticSessionEnd, automaticSessionStart } from './automatic-session.js';

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
  if (typeof value.session_id !== 'string' || typeof value.cwd !== 'string') return runClaudeHook(inputText, env);
  if (value.hook_event_name === 'SessionStart' || value.hook_event_name === 'SessionResume') {
    try {
      const context = await automaticSessionStart('claude', value.session_id, value.cwd, env);
      return context === undefined ? '' : `${JSON.stringify({ hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: context } })}\n`;
    } catch { return ''; }
  }
  if (value.hook_event_name === 'SessionEnd') {
    try { await automaticSessionEnd('claude', value.session_id, value.cwd, env); } catch { /* end remains bounded */ }
    return '';
  }
  return runClaudeHook(inputText, env);
}

export function claudeHookResponse(
  input: NativeHookInput,
  lookup: (sessionId: string) => InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): object | undefined {
  if (typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  if (input.hook_event_name !== 'PostToolBatch') return undefined;
  return presentPendingAtBoundary(
    input.session_id,
    (context) => ({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: context } }),
    lookup,
    env
  );
}

export function runClaudeHook(inputText: string, env: NodeJS.ProcessEnv = process.env): string {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return '';
  }
  if (input === null || typeof input !== 'object') return '';
  const response = claudeHookResponse(input as NativeHookInput, sessionInbox, env);
  return response === undefined ? '' : `${JSON.stringify(response)}\n`;
}
