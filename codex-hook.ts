import { handleCodexHook } from './packages/agent-delivery/src/codex-hook.js';
import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox } from './inbox.js';
import type { Body, PendingMembership } from './model.js';
import { endSessionMemberships } from './session-lifecycle.js';
import { codexBoundaryStore } from './codex-boundary-state.js';
import { PRIVILEGED_HOOK_BUDGET_MS, sweepPrivilegedPending } from './notifications.js';
import type { WakeTransports } from './notifications.js';

export interface CodexHookInput { session_id?: unknown; hook_event_name?: unknown; cwd?: unknown; source?: unknown }
export type HookTrace = (line: string) => void;
export const CODEX_HOOK_BUDGET_MS = 4500;
const defaultTrace: HookTrace = (line) => { process.stderr.write(`${line}\n`); };

export async function codexHookResponse(
  input: CodexHookInput,
  lookup: (identity: Body, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PendingMembership[]> | PendingMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  deliveryTransports?: WakeTransports,
  trace: HookTrace = defaultTrace,
): Promise<object | undefined> {
  const configured = Number(env.SQUARE_CODEX_HOOK_BUDGET_MS ?? CODEX_HOOK_BUDGET_MS);
  const startedAt = Date.now();
  let mark = startedAt;
  return handleCodexHook(input, {
    boundaries: codexBoundaryStore(env),
    timeoutMs: Number.isFinite(configured) && configured > 0 ? configured : CODEX_HOOK_BUDGET_MS,
    sweepTimeoutMs: PRIVILEGED_HOOK_BUDGET_MS,
    pull: (id, signal) => presentPendingAtBoundary({ channel: 'codex', session: id }, (context) => context, lookup, env, signal),
    sweep: (cwd, deadline, signal) => sweepPrivilegedPending(cwd ?? process.cwd(), env, deliveryTransports, deadline, signal),
    end: async (id) => { await endSessionMemberships('codex', id, env); },
    trace: (name, detail = '') => {
      const now = Date.now();
      const durationMs = now - mark;
      mark = now;
      trace(`square-codex-hook: stage=${name} durationMs=${durationMs} totalMs=${now - startedAt}${detail ? ` ${detail}` : ''}`);
    },
  });
}

export async function runCodexHook(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let input: unknown;
  try { input = JSON.parse(inputText); } catch { return ''; }
  if (input === null || typeof input !== 'object') return '';
  const result = await codexHookResponse(input as CodexHookInput, sessionInbox, env);
  return result === undefined ? '' : `${JSON.stringify(result)}\n`;
}

export const runCodexHookAsync = runCodexHook;
