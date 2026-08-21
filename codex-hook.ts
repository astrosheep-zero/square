import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { automaticSessionEnd, automaticSessionStart } from './automatic-session.js';

export interface CodexHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  source?: unknown;
}

export async function codexHookResponse(
  input: CodexHookInput,
  lookup: (sessionId: string) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): Promise<object | undefined> {
  if (typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  if (input.hook_event_name !== 'PostToolUse') return undefined;
  return presentPendingAtBoundary(
    input.session_id,
    (context) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }),
    lookup,
    env
  );
}

export async function runCodexHook(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return '';
  }
  if (input === null || typeof input !== 'object') return '';
  const response = await codexHookResponse(input as CodexHookInput, sessionInbox, env);
  return response === undefined ? '' : `${JSON.stringify(response)}\n`;
}

export async function runCodexHookAsync(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let input: unknown;
  try { input = JSON.parse(inputText); } catch { return ''; }
  if (input === null || typeof input !== 'object') return '';
  const value = input as CodexHookInput;
  if (typeof value.session_id !== 'string' || typeof value.cwd !== 'string') return runCodexHook(inputText, env);
  if (value.hook_event_name === 'SessionStart' || value.hook_event_name === 'SessionResume') {
    try {
      const context = await automaticSessionStart('codex', value.session_id, value.cwd, env);
      return context === undefined ? '' : `${JSON.stringify({ hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: context } })}\n`;
    } catch { return ''; }
  }
  if (value.hook_event_name === 'SessionEnd') {
    try { await automaticSessionEnd('codex', value.session_id, value.cwd, env); } catch { /* end remains bounded */ }
    return '';
  }
  return runCodexHook(inputText, env);
}
