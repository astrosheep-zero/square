import { handleCodexHook, parseCodexHook, type CodexHookInput } from './packages/agent-delivery/src/codex-hook.js';
import { presentPendingAtBoundary } from './boundary-presentation.js';
import { DeliveryLedger } from './delivery-ledger.js';
import { harnessOwner } from './owner.js';
import { attachDeliverySessionRoutes, detachDeliverySession } from './session-lifecycle.js';
import { codexBoundaryStore } from './codex-boundary-state.js';
import { codexWakeAddress } from './codex-address.js';

export type HookTrace = (line: string) => void;
export const CODEX_HOOK_BUDGET_MS = 4500;
const defaultTrace: HookTrace = line => { process.stderr.write(`${line}\n`); };

/** sink resolves only after stdout has accepted the complete hook response. */
export async function codexHookResponse(
  value: unknown,
  sink: ((text: string) => void | Promise<void>) | undefined,
  env: NodeJS.ProcessEnv = process.env,
  trace: HookTrace = defaultTrace,
): Promise<object | undefined> {
  const input = parseCodexHook(value);
  if (!input) return;
  const configured = Number(env.SQUARE_CODEX_HOOK_BUDGET_MS ?? CODEX_HOOK_BUDGET_MS);
  const timeoutMs = Math.min(input.hook_event_name === 'Interrupt' || input.hook_event_name === 'SessionEnd' ? 2500 : CODEX_HOOK_BUDGET_MS,
    Number.isFinite(configured) && configured > 0 ? configured : CODEX_HOOK_BUDGET_MS);
  const signal = AbortSignal.timeout(timeoutMs);
  const owner = harnessOwner({ channel: 'codex', session: input.session_id });
  // Capture before any asynchronous boundary update; a replacement attachment
  // must never inherit this callback's cancellation or detachment.
  let generation: string | undefined;
  if (input.hook_event_name === 'SessionEnd' || input.hook_event_name === 'Interrupt') {
    const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
    try { generation = (await ledger.session(owner))?.generation; } finally { await ledger.close(); }
  }
  const result = await handleCodexHook(input, {
    boundaries: codexBoundaryStore(env), timeoutMs, signal,
    pull: async (_sessionId, pullSignal, event) => {
      if (!sink) return;
      return presentPendingAtBoundary(owner, async context => {
        await sink(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`);
        return context;
      }, env, pullSignal);
    },
    end: async () => { if (generation) await detachDeliverySession(owner, generation, env); },
    interrupt: async () => {
      if (!generation || signal.aborted) return;
      const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
      try { await ledger.cancel({ owner, generation }); } finally { await ledger.close(); }
    },
    trace: name => trace(`square-codex-hook: stage=${name}`),
  });
  // Disarm before rotating the native attachment, even if there is no old session.
  if (input.hook_event_name === 'SessionStart' && !signal.aborted)
    await attachDeliverySessionRoutes(owner, env, [codexWakeAddress(input.session_id, env)], signal);
  return result;
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
