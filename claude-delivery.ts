import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { hostLedgerForEnv, withOwnershipClaimLock } from './registry.js';
import type { EvidenceRecord, HostLedgerPort, PresenceRecord } from './host-ledger.js';
import type { WakeOutcome, WakeRequest } from './ports.js';
import { pendingAtBoundary, projectPresentation, projectPresentationEvidence, presentationSuppressesWake } from './square-projections.js';
import { attentionBodyIsClipped, renderAttentionPreview } from './attention-presentation.js';
import { presentPending } from './presentation-operations.js';
import { deriveDeliveryModel, leaseOwnsNotification } from './delivery.js';
import { freshWatchLease } from './runtime.js';
import { nameKey, type WakeRoute } from './model.js';
import { canonicalRouteLocation } from './routes.js';
import { parseActivityId } from './square-core.js';
import { writeClaudeNative } from './packages/agent-delivery/src/claude-native.js';

const marker = /(?:^|\n)\[square-inbox:([a-zA-Z0-9-]+)\](?:\n|$)/g;
export function nativeTokens(text: string): string[] { return [...text.matchAll(marker)].map((match) => match[1]!); }
export function nativePayload(token: string, preview: string): string { return `[square-inbox:${token}]\n${preview}\n[/square-inbox:${token}]`; }
export function nativeSupported(route: WakeRoute): boolean { return process.platform === 'darwin' && route.address.version === '2.1.295' && route.address.platform === 'darwin' && route.address.loaded === 'true' && !!route.address.endpoint; }

async function currentDelivery(row: EvidenceRecord, hostLedger: HostLedgerPort) {
  const owner = (await hostLedger.listPresence({ location: row.location, participant: row.participant })).find((binding) => binding.session === row.session && binding.epoch === row.nativeDelivery?.epoch);
  if (!owner) return undefined;
  const square = await openSquare(owner.location, { hostLedger });
  try {
    const state = (await square.artifact.read()).state;
    const route = state.routes?.find((candidate) => candidate.kind === 'claude-native' && candidate.sessionId === row.session && nameKey(candidate.participant) === nameKey(row.participant) && candidate.epoch === owner?.epoch && candidate.address.endpoint === row.nativeDelivery?.endpoint);
    const index = parseActivityId(row.activity);
    if (!route || index === undefined || index <= (owner.cancelledThrough ?? -1)) return undefined;
    const projection = await projectPresentation({ artifact: square.artifact, binding: { location: row.location, participant: row.participant, sessionId: row.session, channel: owner.channel, updatedAt: owner.updatedAt ?? 0 } });
    const notification = pendingAtBoundary([{ squarePath: row.location, name: row.participant, notifications: [...projection.notifications], ...(projection.catchLease === undefined ? {} : { catchLease: projection.catchLease }) }])[0]?.notifications.find((entry) => entry.actIndex === index);
    if (!notification || !row.claimToken) return undefined;
    const expected = nativePayload(row.claimToken, renderAttentionPreview({ squarePath: row.location, recipient: row.participant, ...notification }));
    if (expected !== row.nativeDelivery?.payload) return undefined;
    return { owner, notification };
  } finally { await closeOpenSquare(square); }
}

/** Square owns rendering, correlation and evidence; socket transport owns none of them. */
export async function dispatchClaude(request: WakeRequest, hostLedger: HostLedgerPort, timeoutMs: number, beforeSend?: () => Promise<boolean>, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome> {
  request = { ...request, location: await canonicalRouteLocation(request.location) };
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  if (!nativeSupported(request.route)) return { outcome: 'not-capable', diagnostic: 'Claude native inbox requires macOS Claude 2.1.295 and a loaded interactive Square mod.' };
  return withOwnershipClaimLock(env, async () => {
    if (signal.aborted) return { outcome: 'not-capable', diagnostic: 'Native dispatch deadline elapsed before send.' };
    if (!request.claimToken || !await (beforeSend?.() ?? Promise.resolve(true))) return { outcome: 'unknown', signature: 'native_send_suppressed' };
    const owner = (await hostLedger.listPresence({ location: request.location, participant: request.participant })).find((binding) => binding.session === request.route.sessionId && binding.epoch === request.route.epoch);
    if (!owner) return { outcome: 'not-capable', diagnostic: 'Claude binding changed.' };
    const square = await openSquare(request.location, { hostLedger });
    let payload: string;
    try {
      const projection = await projectPresentation({ artifact: square.artifact, binding: { location: request.location, participant: request.participant, sessionId: request.route.sessionId, channel: owner.channel, updatedAt: owner.updatedAt ?? 0 } });
      const notification = pendingAtBoundary([{ squarePath: request.location, name: request.participant, notifications: [...projection.notifications], ...(projection.catchLease === undefined ? {} : { catchLease: projection.catchLease }) }])[0]?.notifications.find((entry) => entry.actIndex === parseActivityId(request.activity));
      if (!notification) return { outcome: 'not-capable', diagnostic: 'Catch or consumption owns this activity.' };
      payload = nativePayload(request.claimToken, renderAttentionPreview({ squarePath: request.location, recipient: request.participant, ...notification }));
    } finally { await closeOpenSquare(square); }
    if (!await (beforeSend?.() ?? Promise.resolve(true))) return { outcome: 'not-capable', diagnostic: 'Native activity was consumed before send.' };
    const row: EvidenceRecord & { claimToken: string; nativeDelivery: NonNullable<EvidenceRecord['nativeDelivery']> } = { location: request.location, participant: request.participant, session: request.route.sessionId, activity: request.activity, kind: 'wake', outcome: 'dispatching', attemptN: request.attemptN, claimToken: request.claimToken, nativeDelivery: { payload, epoch: owner.epoch ?? 0, endpoint: request.route.address.endpoint! } };
    if (!await currentDelivery(row, hostLedger) || !await hostLedger.prepareNativeWake(row)) return { outcome: 'not-capable', diagnostic: 'Native delivery is no longer current.' };
    if (!await (beforeSend?.() ?? Promise.resolve(true)) || !await currentDelivery(row, hostLedger)) return { outcome: 'not-capable', diagnostic: 'Catch, cancellation or consumption won before native write.' };
    const result = await writeClaudeNative({ sessionId: row.session, endpoint: row.nativeDelivery.endpoint }, payload, { deadline, signal });
    if (result.outcome === 'unavailable') return { outcome: 'failed', unavailable: true, retainRoute: true, signature: 'claude_endpoint_unavailable', message: result.message };
    return { outcome: 'unknown', signature: 'native_admission_unconfirmed', message: result.message };
  }, signal);
}

/** Authority comes only from bound memberships and the existing attempt ledger. */
export async function observeClaudeDelivery(sessionId: string, text: string, operation: 'guard' | 'admitted' | 'stored', env: NodeJS.ProcessEnv = process.env): Promise<{ recognized: boolean; current: boolean }> {
  const ledger = hostLedgerForEnv(env);
  return withOwnershipClaimLock(env, async () => {
    const tokens = nativeTokens(text);
    const rows = (await ledger.listEvidence({ kind: 'wake', session: sessionId })).filter((row) => row.nativeDelivery && row.claimToken && tokens.includes(row.claimToken) && ['dispatching', 'unknown', 'accepted'].includes(row.outcome));
    let current = false;
    for (const row of rows) {
      const pending = await currentDelivery(row, ledger).catch(() => undefined);
      if (!pending || !text.includes(row.nativeDelivery!.payload)) continue;
      current = true;
      if (operation === 'admitted') { if (text === row.nativeDelivery!.payload) await ledger.confirmWakeAdmission({ ...row, claimToken: row.claimToken! }); }
      if (operation === 'stored') {
        await ledger.confirmWakeAdmission({ ...row, claimToken: row.claimToken! });
        const prior = await projectPresentationEvidence({ hostLedger: ledger, location: row.location, participant: row.participant, sessionId, activity: row.activity });
        if (presentationSuppressesWake(prior)) continue;
        const square = await openSquare(row.location, { hostLedger: ledger, env });
        try { await presentPending({ artifact: square.artifact, hostLedger: ledger, location: row.location, participant: row.participant, session: sessionId, activity: row.activity, sink: { present() {} }, markSeen: !attentionBodyIsClipped(pending.notification.body), current: (state) => {
          const route = state.routes?.find((candidate) => candidate.kind === 'claude-native' && candidate.sessionId === row.session && candidate.epoch === row.nativeDelivery!.epoch && nameKey(candidate.participant) === nameKey(row.participant) && candidate.address.endpoint === row.nativeDelivery!.endpoint);
          const index = pending.notification.actIndex;
          if (!route || index <= (pending.owner.cancelledThrough ?? -1)) return false;
          const notification = deriveDeliveryModel(state).pendingFor(row.participant).find((entry) => entry.item.index === index);
          const lease = freshWatchLease(state, row.participant, Date.now());
          if (!notification || (lease && leaseOwnsNotification(lease, { ...notification.item, recipient: row.participant, route: notification.route }))) return false;
          return nativePayload(row.claimToken!, renderAttentionPreview({ squarePath: row.location, recipient: row.participant, actIndex: index, actor: notification.item.actor, route: notification.route, body: notification.item.body })) === row.nativeDelivery!.payload;
        } }); }
        finally { await closeOpenSquare(square); }
      }
    }
    return { recognized: rows.length > 0, current };
  });
}

export type ClaudeBinding = Pick<PresenceRecord, 'location' | 'participant' | 'session' | 'epoch'>;
