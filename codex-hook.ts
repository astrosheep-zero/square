import { presentPendingAtBoundary } from './boundary-presentation.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { automaticSessionEnd, automaticSessionStart } from './automatic-session.js';
import { clearCodexBoundary, recordCodexBoundary } from './codex-boundary-state.js';
import { PRIVILEGED_HOOK_BUDGET_MS, sweepPrivilegedPending } from './notifications.js';
import type { WakeAdapter } from './delivery.js';

export interface CodexHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  source?: unknown;
}

export type HookTrace = (line: string) => void;

/** Overall hook budget: Codex kills the hook at its configured 5s timeout, so the hook must
 * bound every wait/retry itself and exit with a readable stage trace before that. */
export const CODEX_HOOK_BUDGET_MS = 4500;

const CODEX_HOOK_EVENTS: Readonly<Record<string, 'PostToolUse' | 'Stop'>> = {
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
};

const defaultTrace: HookTrace = (line) => { process.stderr.write(`${line}\n`); };

/** Per-stage timings, emitted as each stage completes so a killed hook still leaves a trace. */
function stageTracer(trace: HookTrace): (stage: string, extra?: string) => void {
  const startedAt = Date.now();
  let mark = startedAt;
  return (stage, extra = '') => {
    const now = Date.now();
    const durationMs = now - mark;
    mark = now;
    trace(`square-codex-hook: stage=${stage} durationMs=${durationMs} totalMs=${now - startedAt}${extra === '' ? '' : ` ${extra}`}`);
  };
}

function hookBudgetMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.SQUARE_CODEX_HOOK_BUDGET_MS ?? CODEX_HOOK_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : CODEX_HOOK_BUDGET_MS;
}

export async function codexHookResponse(
  input: CodexHookInput,
  lookup: (sessionId: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  deliveryAdapters?: WakeAdapter[],
  trace: HookTrace = defaultTrace,
): Promise<object | undefined> {
  if (typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  if (typeof input.hook_event_name !== 'string') return undefined;
  const hookEventName = CODEX_HOOK_EVENTS[input.hook_event_name];
  if (hookEventName === undefined) return undefined;
  const stage = stageTracer(trace);
  const signal = AbortSignal.timeout(hookBudgetMs(env));
  const sweepDeadline = Date.now() + Math.min(PRIVILEGED_HOOK_BUDGET_MS, hookBudgetMs(env));
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  await recordCodexBoundary(input.session_id, hookEventName === 'Stop' ? 'Stop' : 'non-stop', env);
  stage('boundary-record');
  if (hookEventName === 'Stop') {
    await sweepPrivilegedPending(cwd, env, deliveryAdapters, sweepDeadline, signal).catch(() => undefined);
    stage('sweep', signal.aborted ? 'aborted=true' : '');
    return undefined;
  }
  let response: object | undefined;
  try {
    response = await presentPendingAtBoundary(
      input.session_id,
      (context) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }),
      lookup,
      env,
      signal,
    );
    stage('presentation', signal.aborted ? 'aborted=true' : '');
  } catch (error) {
    stage('presentation', `error=${error instanceof Error ? error.name : String(error)}`);
    response = undefined;
  }
  await sweepPrivilegedPending(cwd, env, deliveryAdapters, sweepDeadline, signal).catch(() => undefined);
  stage('sweep', signal.aborted ? 'aborted=true' : '');
  return response;
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
    await recordCodexBoundary(value.session_id, 'non-stop', env);
    const cwd = typeof value.cwd === 'string' ? value.cwd : process.cwd();
    try {
      const context = await automaticSessionStart('codex', value.session_id, cwd, env);
      return context === undefined ? '' : `${JSON.stringify({ hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: context } })}\n`;
    } catch { return ''; }
  }
  if (value.hook_event_name === 'SessionEnd') {
    await clearCodexBoundary(value.session_id, env);
    const cwd = typeof value.cwd === 'string' ? value.cwd : process.cwd();
    try { await automaticSessionEnd('codex', value.session_id, cwd, env); } catch { /* end remains bounded */ }
    return '';
  }
  return runCodexHook(inputText, env);
}
