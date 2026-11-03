import { handleCodexHook } from './packages/agent-delivery/src/codex-hook.js';
import { presentPendingAtBoundary } from './boundary-presentation.js';
import { DeliveryLedger } from './delivery-ledger.js';
import { harnessOwner } from './owner.js';
import { attachDeliverySessionRoutes, detachDeliverySession } from './session-lifecycle.js';
import { codexBoundaryStore } from './codex-boundary-state.js';
import { codexWakeAddress } from './codex-address.js';
import { dispatchPostedCard } from './notifications.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';

export interface CodexHookInput { session_id?: unknown; hook_event_name?: unknown; cwd?: unknown }
export type HookTrace = (line: string) => void;
export const CODEX_HOOK_BUDGET_MS = 4500;
const defaultTrace: HookTrace = line => { process.stderr.write(`${line}\n`); };

/** sink resolves only after stdout has accepted the complete hook response. */
export async function codexHookResponse(
  input: CodexHookInput,
  sink: ((text: string) => void | Promise<void>) | undefined,
  env: NodeJS.ProcessEnv = process.env,
  trace: HookTrace = defaultTrace,
): Promise<object | undefined> {
  const configured = Number(env.SQUARE_CODEX_HOOK_BUDGET_MS ?? CODEX_HOOK_BUDGET_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : CODEX_HOOK_BUDGET_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const id = typeof input.session_id === 'string' ? input.session_id : '';
  const owner = id ? harnessOwner({ channel: 'codex', session: id }) : undefined;
  if (owner && (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'SessionResume')) {
    await attachDeliverySessionRoutes(owner, env, [codexWakeAddress(id, env)], signal);
  }
  let generation: string | undefined;
  if (owner && input.hook_event_name === 'SessionEnd') {
    const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
    try { generation = (await ledger.session(owner))?.generation; } finally { await ledger.close(); }
  }
  const startedAt = Date.now();
  let mark = startedAt;
  return handleCodexHook(input, {
    boundaries: codexBoundaryStore(env), timeoutMs, signal,
    pull: async (sessionId, pullSignal) => {
      if (!sink) return undefined;
      return presentPendingAtBoundary(harnessOwner({ channel: 'codex', session: sessionId }), async context => {
        const response = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } };
        await sink(`${JSON.stringify(response)}\n`);
        return context;
      }, env, pullSignal);
    },
    sweep: async (_cwd, _deadline, sweepSignal) => {
      if (!owner || sweepSignal.aborted) return;
      const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
      const lifetime = retainDeliveryLedger(ledger);
      try {
        const session = await ledger.session(owner);
        if (!session || session.state !== 'attached') return;
        for (const card of await ledger.pending(owner, { generation: session.generation })) {
          if (sweepSignal.aborted) break;
          await dispatchPostedCard(ledger, owner, card.key, lifetime.track, env, sweepSignal);
        }
      } finally { await lifetime.close(); }
    },
    end: async () => { if (owner && generation) await detachDeliverySession(owner, generation, env); },
    trace: (name, detail = '') => {
      const now = Date.now(), durationMs = now - mark;
      mark = now;
      trace(`square-codex-hook: stage=${name} durationMs=${durationMs} totalMs=${now - startedAt}${detail ? ` ${detail}` : ''}`);
    },
  });
}

/** The caller owns stdout; no receipt is written when no output sink is supplied. */
export async function runCodexHook(inputText: string, env: NodeJS.ProcessEnv = process.env,
  sink?: (text: string) => void | Promise<void>): Promise<string> {
  let input: unknown;
  try { input = JSON.parse(inputText); } catch { return ''; }
  if (input === null || typeof input !== 'object') return '';
  await codexHookResponse(input as CodexHookInput, sink, env);
  return '';
}
