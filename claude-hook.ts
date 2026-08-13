import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';

export interface NativeHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
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
