import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { DeliveryLedger, deliveryLedgerLocation } from './delivery-ledger.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';
import { harnessOwner } from './owner.js';
import { withFileLock } from './file-lock.js';
import { canonicalPath } from './canonical-path.js';
import { codexWakeAddress, codexBoundaryStore } from './codex-address.js';
import { parseCodexHookText } from './codex-hook.js';
import { CodexQueueTransport } from './codex-queue.js';

/** One async Stop waits only for its captured native turn; it never adopts another Stop.
 * Queue admission writes the shared native queue store through the CLI; the hosting
 * Codex process starts queued input only when idle, so no remote idle sampling.
 * Local boundary epochs retire this watcher when a newer Stop or any active native
 * event (UserPromptSubmit/PostToolUse/Interrupt) arrives, keeping active-turn
 * presentation on the synchronous hooks. */
export async function runCodexWatch(inputText: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string> {
  const input = parseCodexHookText(inputText);
  if (input?.hook_event_name !== 'Stop' || signal?.aborted) return '';
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, 86_400_000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let lifetime: ReturnType<typeof retainDeliveryLedger> | undefined;
  try {
    const route = codexWakeAddress(input.session_id, env);
    const home = await canonicalPath(route.address.codexHome);
    const ledger = await DeliveryLedger.open({ location: deliveryLedgerLocation(env), signal: combined });
    lifetime = retainDeliveryLedger(ledger);
    const owner = harnessOwner({ channel: 'codex', session: input.session_id });
    const captured = await ledger.session(owner, combined);
    if (captured?.state !== 'attached') return '';
    // Same-turn duplicates cannot overlap; a later Stop need not wait for an old
    // watcher or a slow late settlement to release a session-wide lock.
    const coordinate = [input.session_id, route.address.endpoint ?? home, captured.generation, input.turn_id];
    const root = path.join(path.dirname(deliveryLedgerLocation(env)), 'codex-watchers');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const lock = path.join(root, createHash('sha256').update(JSON.stringify(coordinate)).digest('hex') + '.lock');
    const file = await fs.open(lock, 'a', 0o600);
    await file.close();
    await withFileLock(lock, { retryMs: 10, skipIfBusy: true, signal: combined }, async () => {
      const boundaries = codexBoundaryStore(env);
      // Record only after winning the lock: a duplicate Stop must not replace the
      // live watcher's epoch and retire both. A newer Stop or active event does.
      await boundaries.record(input.session_id, 'Stop', { turnId: input.turn_id, signal: combined });
      const epoch = (await boundaries.read(input.session_id))?.stop;
      if (!epoch) return;
      const observer = await ledger.observe(owner);
      try {
        while (!combined.aborted) {
          const version = await observer.read(combined);
          if (!await boundaries.queueEligible(input.session_id, epoch)) return;
          const session = await ledger.session(owner, combined);
          if (session?.state !== 'attached' || session.generation !== captured.generation) return;
          const registered = session.routes.find(candidate => candidate.kind === 'codex-queue');
          if (!registered || registered.address.threadId !== input.session_id ||
            registered.address.endpoint !== route.address.endpoint ||
            !registered.address.codexHome || await canonicalPath(registered.address.codexHome) !== home) return;
          const held = new Set((await ledger.handoffs(owner, { generation: captured.generation }, combined))
            .filter(attempt => !['failed', 'released'].includes(attempt.outcome)).map(attempt => attempt.seq));
          const card = (await ledger.pending(owner, { generation: captured.generation }, combined)).find(card => !held.has(card.seq));
          if (card) {
            lifetime!.track(await ledger.dispatchHandoff(owner, card.key, new CodexQueueTransport({ env, address: registered.address }),
              { generation: captured.generation, timeoutMs: 5000, signal: combined }));
            // One handoff attempt ends this wait, including unknown/refused
            // outcomes. Never replay or turn our own writes into a retry loop.
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
    await lifetime?.close();
  }
  return '';
}
