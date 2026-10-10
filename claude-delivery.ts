import { stat } from 'node:fs/promises';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { hostLedgerForEnv } from './registry.js';
import type { EvidenceRecord, HostLedgerPort, PresenceRecord } from './host-ledger.js';
import type { WakeOutcome, WakeRequest, WakeTransportPort } from './ports.js';
import { nativePendingPreview, projectPresentationEvidence, presentationSuppressesWake } from './square-projections.js';
import { presentPending } from './presentation-operations.js';
import { type WakeRoute } from './model.js';
import { canonicalPath } from './canonical-path.js';
import { parseActivityId } from './square-core.js';
import { DeliveryError, connect } from './packages/agent-delivery/src/index.js';

const marker = /(?:^|\n)\[square-inbox:([a-zA-Z0-9-]+)\](?:\n|$)/g;
export function nativeTokens(text: string): string[] { return [...text.matchAll(marker)].map((match) => match[1]!); }
export function nativePayload(token: string, preview: string): string { return `[square-inbox:${token}]\n${preview}\n[/square-inbox:${token}]`; }
function nativeSupported(route: WakeRoute): boolean { return route.address.version === '2.1.295' && route.address.loaded === 'true' && !!route.address.endpoint; }

/**
 * The shared entry owns platform policy, token resolution and frame shape; Square
 * owns the payload, the correlation and the evidence. A local write is never proof
 * of native admission.
 */
async function writeClaudeWake(sessionId: string, endpoint: string, payload: string, timeoutMs: number, signal: AbortSignal): Promise<WakeOutcome> {
  try {
    const agent = await connect({ harness: 'claude', sessionId, endpoint, timeoutMs });
    await agent.steer(payload, { signal });
    return { outcome: 'unknown', signature: 'native_admission_unconfirmed', message: 'Claude accepted the local write; native admission is unconfirmed.' };
  } catch (error) {
    if (error instanceof DeliveryError && !error.maybeDelivered) {
      return { outcome: 'failed', unavailable: true, retainRoute: true, signature: 'claude_endpoint_unavailable', message: error.message };
    }
    return { outcome: 'unknown', signature: 'native_admission_unconfirmed', message: error instanceof Error ? error.message : String(error) };
  }
}

export function createClaudeWakeTransport(hostLedger: HostLedgerPort, env: NodeJS.ProcessEnv = process.env): WakeTransportPort {
  return {
    async probe(route) {
      if (!nativeSupported(route)) return { outcome: 'not-capable', diagnostic: 'Claude native inbox unavailable: Claude 2.1.295 with a loaded interactive Square mod required.' };
      try { return (await stat(route.address.endpoint!)).isSocket() || { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint is not a socket.' }; }
      catch { return { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint unavailable.' }; }
    },
    attempt: (request, timeoutMs, beforeSend) => dispatchClaude(request, hostLedger, timeoutMs, beforeSend, env),
  };
}

async function currentDelivery(row: EvidenceRecord, hostLedger: HostLedgerPort) {
  if (row.nativeDelivery?.harness !== 'claude') return undefined;
  const native = row.nativeDelivery;
  const owner = (await hostLedger.listPresence({ location: row.location, participant: row.participant })).find((binding) => binding.session === row.session && binding.epoch === native.epoch);
  const index = parseActivityId(row.activity);
  if (!owner || index === undefined || !row.claimToken) return undefined;
  const square = await openSquare(owner.location, { hostLedger });
  try {
    const state = (await square.artifact.read()).state;
    const preview = nativePendingPreview(state, { location: row.location, routeKind: 'claude-native', sessionId: row.session, participant: row.participant, actIndex: index, epoch: native.epoch, address: { endpoint: native.endpoint }, cancelledThrough: owner.cancelledThrough, now: Date.now() });
    if (!preview || nativePayload(row.claimToken, preview.payload) !== native.payload) return undefined;
    return { cancelledThrough: owner.cancelledThrough, clipped: preview.clipped };
  } finally { await closeOpenSquare(square); }
}

/** Square owns rendering, correlation and evidence; socket transport owns none of them. */
async function dispatchClaude(request: WakeRequest, hostLedger: HostLedgerPort, timeoutMs: number, beforeSend?: () => Promise<boolean>, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome> {
  request = { ...request, location: await canonicalPath(request.location) };
  const signal = AbortSignal.timeout(timeoutMs);
  if (!nativeSupported(request.route)) return { outcome: 'not-capable', diagnostic: 'Claude native inbox requires Claude 2.1.295 and a loaded interactive Square mod.' };
  return hostLedger.withClaimLock(async () => {
    if (signal.aborted) return { outcome: 'not-capable', diagnostic: 'Native dispatch deadline elapsed before send.' };
    if (!request.claimToken || !await (beforeSend?.() ?? Promise.resolve(true))) return { outcome: 'unknown', signature: 'native_send_suppressed' };
    const owner = (await hostLedger.listPresence({ location: request.location, participant: request.participant })).find((binding) => binding.session === request.route.sessionId && binding.epoch === request.route.epoch);
    if (!owner) return { outcome: 'not-capable', diagnostic: 'Claude binding changed.' };
    const square = await openSquare(request.location, { hostLedger });
    let payload: string;
    try {
      const index = parseActivityId(request.activity);
      const preview = index === undefined ? undefined : nativePendingPreview((await square.artifact.read()).state, { location: request.location, routeKind: 'claude-native', sessionId: request.route.sessionId, participant: request.participant, actIndex: index, epoch: request.route.epoch, address: { endpoint: request.route.address.endpoint! }, cancelledThrough: owner.cancelledThrough, now: Date.now() });
      if (!preview) return { outcome: 'not-capable', diagnostic: 'Catch or consumption owns this activity.' };
      payload = nativePayload(request.claimToken, preview.payload);
    } finally { await closeOpenSquare(square); }
    if (!await (beforeSend?.() ?? Promise.resolve(true))) return { outcome: 'not-capable', diagnostic: 'Native activity was consumed before send.' };
    const native = { harness: 'claude' as const, payload, epoch: owner.epoch ?? 0, endpoint: request.route.address.endpoint! };
    const row = { location: request.location, participant: request.participant, session: request.route.sessionId, activity: request.activity, kind: 'wake' as const, outcome: 'dispatching', routeKind: 'claude-native' as const, attemptN: request.attemptN, claimToken: request.claimToken, nativeDelivery: native };
    if (!await currentDelivery(row, hostLedger) || !await hostLedger.prepareNativeWake(row)) return { outcome: 'not-capable', diagnostic: 'Native delivery is no longer current.' };
    if (!await (beforeSend?.() ?? Promise.resolve(true)) || !await currentDelivery(row, hostLedger)) return { outcome: 'not-capable', diagnostic: 'Catch, cancellation or consumption won before native write.' };
    return writeClaudeWake(row.session, native.endpoint, payload, timeoutMs, signal);
  }, signal);
}

/** Authority comes only from bound memberships and the existing attempt ledger. */
export async function observeClaudeDelivery(sessionId: string, text: string, operation: 'guard' | 'admitted' | 'stored', env: NodeJS.ProcessEnv = process.env): Promise<{ recognized: boolean; current: boolean }> {
  const ledger = hostLedgerForEnv(env);
  return ledger.withClaimLock(async () => {
    const tokens = nativeTokens(text);
    const rows = (await ledger.listEvidence({ kind: 'wake', session: sessionId })).filter((row) => row.nativeDelivery?.harness === 'claude' && row.claimToken && tokens.includes(row.claimToken) && ['dispatching', 'unknown', 'accepted'].includes(row.outcome));
    let current = false;
    for (const row of rows) {
      if (row.nativeDelivery?.harness !== 'claude') continue;
      const native = row.nativeDelivery;
      const pending = await currentDelivery(row, ledger).catch(() => undefined);
      if (!pending || !text.includes(native.payload)) continue;
      current = true;
      if (operation === 'admitted') { if (text === native.payload) await ledger.confirmWakeAdmission({ ...row, claimToken: row.claimToken! }); }
      if (operation === 'stored') {
        await ledger.confirmWakeAdmission({ ...row, claimToken: row.claimToken! });
        const prior = await projectPresentationEvidence({ hostLedger: ledger, location: row.location, participant: row.participant, sessionId, activity: row.activity });
        if (presentationSuppressesWake(prior)) continue;
        const square = await openSquare(row.location, { hostLedger: ledger, env });
        try { await presentPending({ artifact: square.artifact, hostLedger: ledger, location: row.location, participant: row.participant, session: sessionId, activity: row.activity, sink: { present() {} }, markSeen: !pending.clipped, current: (state) => {
          const index = parseActivityId(row.activity);
          if (index === undefined) return false;
          const preview = nativePendingPreview(state, { location: row.location, routeKind: 'claude-native', sessionId: row.session, participant: row.participant, actIndex: index, epoch: native.epoch, address: { endpoint: native.endpoint }, cancelledThrough: pending.cancelledThrough, now: Date.now() });
          return preview !== undefined && nativePayload(row.claimToken!, preview.payload) === native.payload;
        } }); }
        finally { await closeOpenSquare(square); }
      }
    }
    return { recognized: rows.length > 0, current };
  });
}

export type ClaudeBinding = Pick<PresenceRecord, 'location' | 'participant' | 'session' | 'epoch'>;
