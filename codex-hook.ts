import { parseCodexHook, type CodexHookInput } from './packages/agent-delivery/src/codex-hook.js';
import { presentPendingAtBoundary } from './boundary-presentation.js';
import { DeliveryLedger } from './delivery-ledger.js';
import { harnessOwner } from './owner.js';
import { attachDeliverySessionRoutes, detachDeliverySession } from './session-lifecycle.js';
import { codexWakeAddress, codexBoundaryStore } from './codex-address.js';

export type HookTrace = (line: string) => void;
export const CODEX_HOOK_BUDGET_MS = 4500;
const defaultTrace: HookTrace = line => { process.stderr.write(`${line}\n`); };

/** Active delivery uses UserPromptSubmit and PostToolUse; each async Stop owns its own wait. */
export async function codexHookResponse(
  value: unknown,
  sink: ((text: string) => void | Promise<void>) | undefined,
  env: NodeJS.ProcessEnv = process.env,
  trace: HookTrace = defaultTrace,
): Promise<void> {
  const input = parseCodexHook(value);
  if (!input) return;
  const configured = Number(env.SQUARE_CODEX_HOOK_BUDGET_MS ?? CODEX_HOOK_BUDGET_MS);
  const timeoutMs = Math.min(input.hook_event_name === 'Interrupt' || input.hook_event_name === 'SessionEnd' ? 2500 : CODEX_HOOK_BUDGET_MS,
    Number.isFinite(configured) && configured > 0 ? configured : CODEX_HOOK_BUDGET_MS);
  const signal = AbortSignal.timeout(timeoutMs);
  const owner = harnessOwner({ channel: 'codex', session: input.session_id });
  // Active native events disarm idle queueing; Stop arms its own async watcher.
  // This file state is the only activity gate: no app-server sampling.
  await codexBoundaryStore(env).record(input.session_id,
    input.hook_event_name === 'SessionStart' ? 'start' : input.hook_event_name === 'SessionEnd' ? 'end' : 'non-stop',
    { signal, turnId: input.turn_id });
  if (input.hook_event_name === 'SessionStart') {
    await attachDeliverySessionRoutes(owner, env, [codexWakeAddress(input.session_id, env)], signal);
  } else if (input.hook_event_name === 'SessionEnd' || input.hook_event_name === 'Interrupt') {
    const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY, signal });
    try {
      const captured = await ledger.session(owner, signal);
      if (!captured || signal.aborted) return;
      if (input.hook_event_name === 'SessionEnd') await detachDeliverySession(owner, captured.generation, env, signal);
      else await ledger.cancel({ owner, generation: captured.generation }, signal);
    } finally { await ledger.close(); }
  } else if ((input.hook_event_name === 'UserPromptSubmit' || input.hook_event_name === 'PostToolUse') && sink) {
    try {
      await presentPendingAtBoundary(owner, async context => {
        await sink(`${JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context } })}\n`);
      }, env, signal);
      trace('square-codex-hook: stage=presentation');
    } catch (error) {
      trace(`square-codex-hook: stage=presentation error=${error instanceof Error ? error.name : 'Error'}`);
    }
  }
}

export function parseCodexHookText(text: string): CodexHookInput | undefined {
  try { return parseCodexHook(JSON.parse(text)); } catch { return; }
}

/** The caller owns stdout; no receipt is written when no output sink is supplied. */
export async function runCodexHook(inputText: string, env: NodeJS.ProcessEnv = process.env,
  sink?: (text: string) => void | Promise<void>): Promise<string> {
  await codexHookResponse(parseCodexHookText(inputText), sink, env);
  return '';
}

export async function runCodexInterrupt(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const input = parseCodexHookText(inputText);
  if (input?.hook_event_name === 'Interrupt') {
    try { await codexHookResponse(input, undefined, env); }
    catch { throw new Error('Codex interrupt unavailable.'); }
  }
  return '';
}
