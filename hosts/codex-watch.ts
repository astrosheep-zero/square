import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from '../packages/agent-delivery/src/index.js';
import { codexQueueEndpoint } from '../packages/agent-delivery/src/codex-endpoint.js';
import { DeliveryLedger, deliveryLedgerLocation } from '../ledger/delivery-ledger.js';
import { harnessOwner } from '../core/owner.js';
import { withFileLock } from '../packages/agent-delivery/src/file-lock.js';
import { canonicalPath } from '../storage/canonical-path.js';
import { codexWakeAddress, codexBoundaryStore } from './codex-address.js';
import { parseCodexHookText } from './codex-hook.js';

/** One async Stop waits only for its captured native turn; it never adopts another Stop.
 * Queue admission writes the shared native queue store through the CLI; the hosting
 * Codex process starts queued input only when idle, so no remote idle sampling.
 * Local boundary epochs retire this watcher when a newer Stop or any active native
 * event (UserPromptSubmit/PostToolUse/Interrupt) arrives, keeping active-turn
 * presentation on the synchronous hooks. */
export async function runCodexWatch(inputText: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<void> {
  const input = parseCodexHookText(inputText);
  if (input?.hook_event_name !== 'Stop' || signal?.aborted) return;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, 86_400_000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const location = deliveryLedgerLocation(env);
  let ledger: DeliveryLedger | undefined;
  try {
    const route = codexWakeAddress(input.session_id, env);
    const home = await canonicalPath(route.address.codexHome);
    const currentLedger = await DeliveryLedger.open({ location, signal: combined });
    ledger = currentLedger;
    const owner = harnessOwner({ channel: 'codex', session: input.session_id });
    const captured = await currentLedger.session(owner, combined);
    if (captured?.state !== 'attached') return;
    // Same-turn duplicates cannot overlap; a later Stop need not wait for an old
    // watcher or a slow late settlement to release a session-wide lock.
    const coordinate = [input.session_id, route.address.endpoint ?? home, captured.generation, input.turn_id];
    const root = path.join(path.dirname(location), 'codex-watchers');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const lock = path.join(root, createHash('sha256').update(JSON.stringify(coordinate)).digest('hex') + '.lock');
    const file = await fs.open(lock, 'a', 0o600);
    await file.close();
    await withFileLock(lock, { retryMs: 10, skipIfBusy: true, signal: combined }, async () => {
      const boundaries = codexBoundaryStore(env);
      // Only the lock winner records, and the returned epoch is this write's own.
      const epoch = await boundaries.record(input.session_id, 'Stop', { turnId: input.turn_id, signal: combined });
      if (!epoch) return;
      const eligible = async () => {
        if (combined.aborted || !await boundaries.queueEligible(input.session_id, epoch)) return;
        const session = await currentLedger.session(owner, combined);
        if (session?.state !== 'attached' || session.generation !== captured.generation) return;
        const registered = session.routes.find(candidate => candidate.kind === 'codex-queue');
        if (!registered || registered.address.threadId !== input.session_id ||
          registered.address.endpoint !== route.address.endpoint ||
          !registered.address.codexHome || await canonicalPath(registered.address.codexHome) !== home) return;
        const held = new Set((await currentLedger.handoffs(owner, { generation: captured.generation }, combined))
          .filter(attempt => !['failed', 'released'].includes(attempt.outcome)).map(attempt => attempt.seq));
        const cards = await currentLedger.pending(owner, { generation: captured.generation }, combined);
        return { address: registered.address, pending: cards.some(card => !held.has(card.seq)) };
      };
      const observer = await currentLedger.observe(owner);
      try {
        while (!combined.aborted) {
          const version = await observer.read(combined);
          const current = await eligible();
          if (!current) return;
          if (current.pending) {
            await queueCodexWake(current.address, async () => !!(await eligible())?.pending, env, combined);
            // Wake admission owns no card. Unknown/refused wakes also end this
            // wait without retries; synchronous hooks retain the original body.
            return;
          }
          await observer.changed(version, 1000, combined);
        }
      } finally { observer.close(); }
    });
  } catch {
    if (!combined.aborted) throw new Error('Codex watcher unavailable.');
  } finally {
    clearTimeout(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await ledger?.close();
  }
}

/** Receiver-owned wake admission only; the queued turn fetches its own current context. */
async function queueCodexWake(address: Readonly<Record<string, string>>, eligible: () => Promise<boolean>,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5000;
  try {
    const endpoint = address.endpoint ?? codexQueueEndpoint({ CODEX_HOME: address.codexHome });
    const agent = await connect({ harness: 'codex', transport: 'cli', sessionId: address.threadId,
      boundaries: { queueEligible: async () => await eligible() && !signal.aborted && Date.now() < deadline },
      env, bin: env.SQUARE_CODEX_BIN, codexHome: address.codexHome, endpoint });
    if (signal.aborted || Date.now() >= deadline) return;
    await agent.queue('Square wake: use only the current external notification context supplied for this turn. If none is supplied, this wake is obsolete; do not repeat earlier work.',
      { timeoutMs: deadline - Date.now(), signal });
  } catch { /* Refused and unknown admissions both end this wait without retry. */ }
}
