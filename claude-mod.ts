import { automaticSessionStart, operationEnv } from './automatic-session.js';
import { claimSessionParticipant, hostLedgerForEnv } from './registry.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { publishWakeRoute, retireWakeRouteFromArtifact } from './routes.js';
import { Square } from './square-wiring.js';
import { observeClaudeDelivery, type ClaudeBinding } from './claude-delivery.js';
import { processActNotificationsOnce } from './notifications.js';
import { sweepPending } from './delivery-operations.js';

export interface ClaudeCoordinate { readonly sessionId: string; readonly cwd: string; readonly version: string; readonly endpoint?: string }
interface ClaudeBridgeInput extends ClaudeCoordinate {
  readonly operation: 'start' | 'reconcile' | 'end' | 'cancel' | 'guard' | 'admitted' | 'stored';
  readonly bindings?: readonly ClaudeBinding[];
  readonly resume?: boolean;
  readonly text?: string;
  readonly cancelAt?: number;
  readonly cancelledBindings?: readonly ClaudeBinding[];
  readonly endedAt?: number;
}

/** JSON stdin bridge. Identity is explicit per operation; process.env is never rewritten. */
export async function runClaudeMod(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (inputText.length > 512_000) throw new Error('Claude bridge input exceeds its bound.');
  const input = JSON.parse(inputText) as ClaudeBridgeInput;
  if (!input || typeof input.sessionId !== 'string' || !input.sessionId || typeof input.cwd !== 'string') throw new Error('Claude bridge coordinate missing.');
  const scoped = operationEnv('claude', input.sessionId, env);
  const ledger = hostLedgerForEnv(env);
  const signal = AbortSignal.timeout(2500);
  const supported = process.platform === 'darwin' && input.version === '2.1.295' && typeof input.endpoint === 'string' && input.endpoint.startsWith('/');
  if (input.operation === 'end') {
    const retired: ClaudeBinding[] = [];
    const captured = [...input.bindings ?? []];
    // Discover committed late joins at the pinned end boundary, never later owners.
    if (input.endedAt !== undefined) for (const row of await ledger.listPresence({ session: input.sessionId })) {
      if (row.channel === 'claude-code' && (row.updatedAt ?? Infinity) <= input.endedAt && !captured.some((binding) => binding.location === row.location && binding.participant === row.participant)) captured.push(row);
    }
    for (const binding of captured) {
      if (binding.session !== input.sessionId || !Number.isSafeInteger(binding.epoch)) continue;
      const square = await Square.at({ path: binding.location, hostLedger: ledger, env: scoped });
      try {
        const ended = await square.endOwnedSession(binding.participant, input.sessionId, binding.epoch);
        if (ended?.activity) {
          retired.push(binding);
          const row = { location: binding.location, participant: binding.participant, session: input.sessionId, activity: ended.activity.id, kind: 'lifecycle' as const, bindingEpoch: binding.epoch, outcome: 'retired' };
          const claim = await ledger.claimEvidence({ ...row, leaseMs: 1000 });
          if (claim.status === 'acquired') await ledger.appendEvidence({ ...row, claimToken: claim.claimToken });
        }
      }
      finally { await square.close(); }
      if (signal.aborted) break;
    }
    return `${JSON.stringify({ retired })}\n`;
  }
  const recovery = new Set<string>();
  const cancelledBindings = [...input.cancelledBindings ?? []];
  if (input.operation === 'start') {
    // Host state survives reload, not conversation replacement. Resume authority is
    // the existing lifecycle ledger plus the exact ended activity, never peer text.
    if (input.resume) for (const row of await ledger.listEvidence({ kind: 'lifecycle', session: input.sessionId })) {
      if (signal.aborted || row.outcome !== 'retired' || !Number.isSafeInteger(row.bindingEpoch)) continue;
      const probe = await openSquare(row.location, { hostLedger: ledger, env: scoped, signal });
      let eligible = false;
      try {
        const state = (await probe.artifact.read(signal)).state;
        const last = state.acts.findLast((activity) => activity.actor === row.participant && ['join', 'done', 'kick'].includes(activity.kind));
        eligible = last?.kind === 'done' && `act/${last.index}` === row.activity;
      } finally { await closeOpenSquare(probe); }
      if (!eligible) continue;
      const claimed = await ledger.claimPresence({ location: row.location, participant: row.participant, session: input.sessionId, channel: 'claude-code', epoch: row.bindingEpoch! + 1, updatedAt: Date.now() }, signal);
      if (claimed.status !== 'acquired') continue;
      const square = await Square.at({ path: row.location, hostLedger: ledger, env: scoped });
      try { await square.join(row.participant); }
      catch { await ledger.removePresenceIfUnchanged(claimed.record); }
      finally { await square.close(); }
    }
    await automaticSessionStart('claude', input.sessionId, input.cwd, env);
  }
  if (input.operation === 'start' || input.operation === 'reconcile' || input.operation === 'cancel' || input.cancelAt !== undefined) {
    const memberships = await ledger.listPresence({ session: input.sessionId });
    for (const binding of memberships) {
      if (binding.channel !== 'claude-code' || signal.aborted) continue;
      const expected = input.bindings?.find((row) => row.location === binding.location && row.participant === binding.participant && row.session === input.sessionId);
      const cancelled = input.cancelledBindings?.find((row) => row.location === binding.location && row.participant === binding.participant && row.session === input.sessionId)
        ?? (input.operation === 'cancel' ? expected : undefined);
      const lateCancelledJoin = input.operation === 'cancel' && input.cancelAt !== undefined && (binding.updatedAt ?? Infinity) <= input.cancelAt && expected === undefined;
      if (lateCancelledJoin) cancelledBindings.push(binding);
      if (input.operation !== 'start' && input.operation !== 'reconcile' && !lateCancelledJoin && (!expected || expected.epoch !== binding.epoch)) continue;
      const claim = await claimSessionParticipant(binding.location, binding.participant, ledger, scoped, signal);
      if (!claim || claim.epoch !== (binding.epoch ?? 0)) continue;
      await ledger.withClaimLock(async () => {
        const current = (await ledger.listPresence({ location: binding.location, participant: binding.participant })).find((row) => row.session === input.sessionId && (row.epoch ?? 0) === claim.epoch);
        if (!current) return;
        const epoch = claim.epoch || 1;
        if (current.epoch !== epoch) await ledger.ensurePresence({ ...current, epoch });
        const square = await openSquare(binding.location, { hostLedger: ledger, env: scoped, signal });
        try {
          const state = (await square.artifact.read(signal)).state;
          const existing = state.routes?.find((route) => route.participant === binding.participant && route.sessionId === input.sessionId && route.kind === 'claude-native' && route.epoch === epoch);
          if (!supported) { if (existing) await retireWakeRouteFromArtifact(square.artifact, existing, { expectedEpoch: epoch }); return; }
          const cutoff = cancelled?.epoch === epoch || (lateCancelledJoin && current.epoch === binding.epoch && (current.updatedAt ?? Infinity) <= input.cancelAt!) ? input.cancelAt : undefined;
          if (cutoff !== undefined) {
            const through = state.acts.filter((activity) => activity.at <= cutoff).reduce((highest, activity) => Math.max(highest, activity.index), -1);
            await ledger.suppressPresence({ ...current, epoch }, through);
          }
          if (!existing || existing.address.endpoint !== input.endpoint) recovery.add(binding.location);
          await publishWakeRoute(square.artifact, { location: binding.location, participant: binding.participant, sessionId: input.sessionId, channel: 'claude-code', kind: 'claude-native', epoch, address: { sessionId: input.sessionId, endpoint: input.endpoint!, version: input.version, platform: 'darwin', loaded: 'true' } }, { requireCurrentSession: true });
        } finally { await closeOpenSquare(square); }
      }, signal);
    }
  }
  if (input.operation === 'start' || input.operation === 'reconcile' || input.operation === 'cancel') {
    const bindings = (await ledger.listPresence({ session: input.sessionId })).filter((row) => row.channel === 'claude-code').map(({ location, participant, session, epoch }) => ({ location, participant, session, epoch }));
    // One startup recovery pass for known unsent work. Unknown/admitted sends never replay.
    if (supported && input.operation !== 'cancel') for (const binding of bindings) {
      if (signal.aborted) break;
      if (input.operation !== 'start' && !recovery.has(binding.location)) continue;
      const square = await openSquare(binding.location, { hostLedger: ledger, env, signal });
      let indices: number[];
      try { indices = await sweepPending({ artifact: square.artifact, hostLedger: ledger, location: binding.location, now: Date.now(), graceMs: 0, limit: 8 }); }
      finally { await closeOpenSquare(square); }
      for (const index of indices) { if (signal.aborted) break; await processActNotificationsOnce(binding.location, index, { env: { ...env, SQUARE_NOTIFY_DELIVERY_WAIT_MS: '200' } }); }
    }
    return `${JSON.stringify({ available: supported, diagnostic: supported ? undefined : 'Native inbox unavailable: requires macOS Claude 2.1.295, an interactive loaded mod and its real endpoint.', bindings, cancelledBindings })}\n`;
  }
  if (!['guard', 'admitted', 'stored'].includes(input.operation) || typeof input.text !== 'string') throw new Error('Unknown Claude bridge operation.');
  return `${JSON.stringify(await observeClaudeDelivery(input.sessionId, input.text, input.operation as 'guard' | 'admitted' | 'stored', env))}\n`;
}
