import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox, type InboxMembership } from './inbox.js';

export interface CodexHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
}

export function codexHookResponse(
  input: CodexHookInput,
  lookup: (sessionId: string) => InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): object | undefined {
  if (typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  if (input.hook_event_name !== 'PostToolUse') return undefined;
  return presentPendingAtBoundary(
    input.session_id,
    (context) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }),
    lookup,
    env
  );
}

export function runCodexHook(inputText: string, env: NodeJS.ProcessEnv = process.env): string {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return '';
  }
  if (input === null || typeof input !== 'object') return '';
  const response = codexHookResponse(input as CodexHookInput, sessionInbox, env);
  return response === undefined ? '' : `${JSON.stringify(response)}\n`;
}
