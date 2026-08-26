import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { automaticSessionEnd, automaticSessionStart } from './automatic-session.js';
import { clearCodexBoundary, recordCodexBoundary } from './codex-boundary-state.js';

export interface CodexHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  source?: unknown;
}

const CODEX_HOOK_EVENTS: Readonly<Record<string, 'PostToolUse' | 'Stop'>> = {
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
};

export async function codexHookResponse(
  input: CodexHookInput,
  lookup: (sessionId: string) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): Promise<object | undefined> {
  if (typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  if (typeof input.hook_event_name !== 'string') return undefined;
  const hookEventName = CODEX_HOOK_EVENTS[input.hook_event_name];
  if (hookEventName === undefined) return undefined;
  recordCodexBoundary(input.session_id, hookEventName === 'Stop' ? 'Stop' : 'non-stop', env);
  return presentPendingAtBoundary(
    input.session_id,
    (context) => hookEventName === 'Stop'
      ? { systemMessage: context }
      : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } },
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
  if (typeof value.session_id !== 'string') return runCodexHook(inputText, env);
  if (value.hook_event_name === 'SessionStart' || value.hook_event_name === 'SessionResume') {
    recordCodexBoundary(value.session_id, 'non-stop', env);
    const cwd = typeof value.cwd === 'string' ? value.cwd : process.cwd();
    try {
      const context = await automaticSessionStart('codex', value.session_id, cwd, env);
      return context === undefined ? '' : `${JSON.stringify({ hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: context } })}\n`;
    } catch { return ''; }
  }
  if (value.hook_event_name === 'SessionEnd') {
    clearCodexBoundary(value.session_id, env);
    const cwd = typeof value.cwd === 'string' ? value.cwd : process.cwd();
    try { await automaticSessionEnd('codex', value.session_id, cwd, env); } catch { /* end remains bounded */ }
    return '';
  }
  return runCodexHook(inputText, env);
}
