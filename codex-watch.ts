import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { DeliveryLedger, deliveryLedgerLocation } from './delivery-ledger.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';
import { harnessOwner } from './owner.js';
import { withFileLock } from './file-lock.js';
import { canonicalPath } from './canonical-path.js';
import { codexBoundaryStore } from './codex-boundary-state.js';
import { codexWakeAddress } from './codex-address.js';
import { parseCodexHookText } from './codex-hook.js';
import { CodexQueueTransport } from './codex-queue.js';
import { codexIdleAtStop } from './packages/agent-delivery/src/codex.js';

/** One native async hook owns observation; the lock itself conveys no idle authority. */
export async function runCodexWatch(inputText: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string> {
  const input = parseCodexHookText(inputText);
  if (input?.hook_event_name !== 'Stop' || signal?.aborted) return '';
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, 86_400_000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const route = codexWakeAddress(input.session_id, env);
    const home = await canonicalPath(route.address.codexHome);
    const coordinate = [input.session_id, route.address.endpoint ?? home];
    const root = path.join(path.dirname(deliveryLedgerLocation(env)), 'codex-watchers');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const lock = path.join(root, createHash('sha256').update(JSON.stringify(coordinate)).digest('hex') + '.lock');
    const file = await fs.open(lock, 'a', 0o600);
    await file.close();
    await withFileLock(lock, { retryMs: 10, skipIfBusy: true, signal: combined }, async () => {
      const ledger = await DeliveryLedger.open({ location: deliveryLedgerLocation(env) });
      const lifetime = retainDeliveryLedger(ledger);
      let observer: Awaited<ReturnType<DeliveryLedger['observe']>> | undefined;
      try {
        const owner = harnessOwner({ channel: 'codex', session: input.session_id });
        const captured = await ledger.session(owner);
        if (captured?.state !== 'attached') return;
        const boundaries = codexBoundaryStore(env);
        // Subscribe before inspecting pending work. Both ledger edges and the
        // bounded wait below cause reconciliation; boundary-only changes matter.
        observer = await ledger.observe(owner);
        while (!combined.aborted) {
          let version = await observer.read(combined);
          const session = await ledger.session(owner);
          if (session?.state !== 'attached' || session.generation !== captured.generation) return;
          const registered = session.routes.find(candidate => candidate.kind === 'codex-queue');
          if (!registered || registered.address.threadId !== input.session_id ||
            registered.address.endpoint !== route.address.endpoint ||
            !registered.address.codexHome || await canonicalPath(registered.address.codexHome) !== home) return;
          const boundary = await boundaries.read(input.session_id);
          if (boundary?.ended) return;
          const pending = await ledger.pending(owner, { generation: captured.generation });
          const held = new Set((await ledger.handoffs(owner, { generation: captured.generation }))
            .filter(attempt => !['failed', 'released'].includes(attempt.outcome)).map(attempt => attempt.seq));
          for (const card of pending) {
            if (combined.aborted) break;
            if (held.has(card.seq)) continue;
            // Follow the latest Stop, regardless of which Stop launched this process.
            const epoch = (await boundaries.read(input.session_id))?.stop;
            if (!epoch || !await codexIdleAtStop({ harness: 'codex', sessionId: input.session_id,
              codexHome: registered.address.codexHome, endpoint: registered.address.endpoint,
              timeoutMs: 2000, signal: combined }, epoch.turnId)) break;
            lifetime.track(await ledger.dispatchHandoff(owner, card.key, new CodexQueueTransport({ epoch, env, address: registered.address }),
              { generation: captured.generation, timeoutMs: 5000, signal: combined }));
            // Drain our own claim/settlement edge. A known-unsent failure must
            // not turn file observation into an immediate retry loop. Any post
            // racing this read is still found by the bounded rescan below.
            version = await observer.read(combined);
          }
          // No claims are held while waiting, including while active or disarmed.
          await observer.changed(version, 1000, combined);
        }
      } finally { observer?.close(); await lifetime.close(); }
    });
  } catch {
    if (!combined.aborted) throw new Error('Codex watcher unavailable.');
  } finally {
    clearTimeout(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
  return '';
}
