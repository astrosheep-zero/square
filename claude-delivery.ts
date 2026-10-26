import { stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createArtifactPort } from './artifact.js';
import { presentPending } from './presentation-operations.js';
import { projectSessionCandidates, nativePendingPreview } from './inbox.js';
import { sameBody, type WakeRoute } from './model.js';
import { parseActivityId } from './square-core.js';
import type { DeliveryEvidence, SquareArtifactPort, SquareRead, WakeOutcome, WakeRequest, WakeTransportPort } from './ports.js';
import { asSeatRef } from './seats.js';
import { writeClaudeNative } from './packages/agent-delivery/src/claude-native.js';

const marker = /(?:^|\n)\[square-inbox:([a-zA-Z0-9-]+)\](?:\n|$)/g;
export function nativeTokens(text: string): string[] { return [...text.matchAll(marker)].map((match) => match[1]!); }
export function nativePayload(token: string, preview: string): string { return `[square-inbox:${token}]\n${preview}\n[/square-inbox:${token}]`; }
function nativeSupported(route: WakeRoute): boolean { return route.address.loaded === 'true' && !!route.address.endpoint; }
function sameAddress(left: Readonly<Record<string, string>> | undefined, right: Readonly<Record<string, string>>): boolean {
  if (left === undefined) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
function hashPayload(payload: string): string { return createHash('sha256').update(payload).digest('hex'); }

interface NativePreview {
  readonly payload: string;
  readonly clipped: boolean;
}

function previewFacts(facts: import('./ports.js').SquareRead, request: WakeRequest): NativePreview | undefined {
  const index = parseActivityId(request.activity);
  if (index === undefined || request.route.kind !== 'claude-native' || request.route.address.endpoint === undefined) return undefined;
  return nativePendingPreview(facts, { location: request.location, routeKind: 'claude-native', sessionId: request.route.sessionId,
    participant: request.participant, actIndex: index, address: { endpoint: request.route.address.endpoint }, now: Date.now() });
}

async function preview(artifact: SquareArtifactPort, request: WakeRequest): Promise<NativePreview | undefined> {
  return (await artifact.read((facts) => previewFacts(facts, request))).value;
}

async function writeClaudeWake(sessionId: string, endpoint: string, messageId: string, payload: string, timeoutMs: number, signal: AbortSignal): Promise<WakeOutcome> {
  const result = await writeClaudeNative({ sessionId, endpoint, messageId }, payload, { deadline: Date.now() + timeoutMs, signal });
  if (result.outcome === 'unavailable') return { outcome: 'failed', unavailable: true, retainRoute: true, signature: 'claude_endpoint_unavailable', message: result.message };
  return { outcome: 'unknown', signature: 'native_admission_unconfirmed', message: result.outcome === 'written' ? 'Claude accepted the local write; native admission is unconfirmed.' : result.message };
}

export function createClaudeWakeTransport(env: NodeJS.ProcessEnv = process.env): WakeTransportPort {
  return {
    async probe(route) {
      if (!nativeSupported(route)) return { outcome: 'not-capable', diagnostic: 'Claude native inbox unavailable: a loaded interactive Square mod is required.' };
      try { return (await stat(route.address.endpoint!)).isSocket() || { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint is not a socket.' }; }
      catch { return { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint unavailable.' }; }
    },
    attempt: (request, timeoutMs, beforeSend) => dispatchClaude(request, timeoutMs, beforeSend, env),
  };
}

async function dispatchClaude(request: WakeRequest, timeoutMs: number, beforeSend?: () => Promise<boolean>, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome> {
  void env;
  const signal = AbortSignal.timeout(timeoutMs);
  if (!nativeSupported(request.route) || request.artifact === undefined || request.claimToken === undefined)
    return { outcome: 'not-capable', diagnostic: 'Claude native delivery needs a current artifact claim and loaded inbox.' };
  if (signal.aborted || !await (beforeSend?.() ?? Promise.resolve(true)))
    return { outcome: 'unknown', signature: 'native_send_suppressed' };
  const prepared = await preview(request.artifact, request);
  if (prepared === undefined) return { outcome: 'not-capable', diagnostic: 'Claude activity is no longer current.' };
  const messageId = randomUUID();
  const payload = nativePayload(request.claimToken, prepared.payload);
  const correlation = { harness: 'claude' as const, token: request.claimToken, messageId, payloadHash: hashPayload(payload) };
  if (!await request.artifact.prepareDelivery({ seat: request.seat, claimToken: request.claimToken, correlation }))
    return { outcome: 'not-capable', diagnostic: 'Claude delivery claim is no longer current.' };
  if (!await (beforeSend?.() ?? Promise.resolve(true))) return { outcome: 'not-capable', diagnostic: 'Claude activity was consumed before native write.' };
  const fresh = await preview(request.artifact, request);
  if (fresh === undefined || nativePayload(request.claimToken, fresh.payload) !== payload)
    return { outcome: 'not-capable', diagnostic: 'Claude activity changed before native write.' };
  return writeClaudeWake(request.route.sessionId, request.route.address.endpoint!, messageId, payload, timeoutMs, signal);
}

interface NativeRow {
  readonly artifact: SquareArtifactPort;
  readonly evidence: DeliveryEvidence;
  readonly request?: WakeRequest;
  readonly payload?: string;
}

function currentPayload(facts: SquareRead, request: WakeRequest): string | undefined {
  const seat = facts.seat(request.participant), evidence = facts.deliveryByToken(request.claimToken!);
  if (seat === undefined || evidence === undefined || seat.generation !== evidence.generation
    || seat.generation !== request.seat.generation || !sameBody(seat.body, request.seat.body)
    || seat.body.channel !== 'claude-code' || seat.body.session !== request.route.sessionId
    || evidence.activity !== request.activity || !['dispatching', 'unknown', 'accepted'].includes(evidence.outcome)
    || seat.wakeAddress?.kind !== 'claude-native' || !sameAddress(seat.wakeAddress.address, request.route.address)) return undefined;
  const native = previewFacts(facts, request);
  if (native === undefined) return undefined;
  const payload = nativePayload(request.claimToken!, native.payload);
  return evidence.correlation?.payloadHash === hashPayload(payload) ? payload : undefined;
}

async function rowsForSession(sessionId: string, env: NodeJS.ProcessEnv, tokens: readonly string[]): Promise<NativeRow[]> {
  const rows: NativeRow[] = [];
  const paths = new Set((await projectSessionCandidates({ sessionId, channel: 'claude-code', env })).map(candidate => candidate.location));
  for (const location of paths) {
    const artifact = createArtifactPort(location);
    try {
      const found = await artifact.read((facts) => tokens.flatMap((token): NativeRow[] => {
        const evidence = facts.deliveryByToken(token);
        if (evidence?.kind !== 'wake' || evidence.correlation?.harness !== 'claude' || evidence.correlation.token !== token
          || evidence.route?.kind !== 'claude-native' || evidence.route.address.sessionId !== sessionId) return [];
        const row = { artifact, evidence };
        const seat = facts.seat(evidence.participant), index = parseActivityId(evidence.activity);
        const item = index === undefined ? undefined : facts.activity(index);
        if (seat === undefined || item?.kind !== 'say') return [row];
        const route: WakeRoute = { location, participant: seat.participant, sessionId, channel: 'claude-code',
          ...evidence.route, updatedAt: evidence.at };
        const request: WakeRequest = { location, participant: seat.participant, activity: evidence.activity,
          actor: item.actor, seat: asSeatRef(seat), claimToken: token, attemptN: evidence.attemptN, route, artifact };
        return [{ ...row, request, payload: currentPayload(facts, request) }];
      }));
      rows.push(...found.value);
      if (found.value.length === 0) await artifact.close();
    } catch { await artifact.close(); }
  }
  return rows;
}

/** Recognize the whole frame first; one inactive token vetoes it before any evidence/receipt write. */
export async function observeClaudeDelivery(sessionId: string, text: string, operation: 'guard' | 'admitted' | 'stored', env: NodeJS.ProcessEnv = process.env): Promise<{ recognized: boolean; current: boolean }> {
  const tokens = nativeTokens(text);
  if (tokens.length === 0) return { recognized: false, current: false };
  const rows = await rowsForSession(sessionId, env, [...new Set(tokens)]);
  const recognized = rows.length > 0;
  const frames = [...text.matchAll(/(?:^|\n)(\[square-inbox:([a-zA-Z0-9-]+)\]\n[\s\S]*?\n\[\/square-inbox:\2\])(?=\n|$)/g)];
  try {
    if (!recognized || rows.some(row => {
      const matching = frames.filter(frame => frame[2] === row.evidence.claimToken);
      return row.payload === undefined || matching.length !== tokens.filter(token => token === row.evidence.claimToken).length
        || matching.some(frame => frame[1] !== row.payload);
    })) return { recognized, current: false };
    for (const row of rows) {
      if (operation === 'guard') continue;
      const request = row.request!, payload = row.payload!;
      const admitted = await row.artifact.transactAs({ kind: 'participant', seat: request.seat }, facts =>
        currentPayload(facts, request) === payload && facts.completeDelivery({ seat: request.seat,
          activity: row.evidence.activity, claimToken: request.claimToken!, outcome: 'accepted', at: Date.now() })).catch(() => ({ value: false }));
      if (!admitted.value) return { recognized, current: false };
      if (operation === 'stored') await presentPending({ artifact: row.artifact, location: request.location,
        participant: request.participant, activity: request.activity, seat: request.seat, sink: { present() {} },
        current: facts => currentPayload(facts, request) === payload });
    }
    return { recognized, current: true };
  } finally { await Promise.all([...new Set(rows.map(row => row.artifact))].map(artifact => artifact.close())); }
}

export type ClaudeBinding = {
  readonly location: string;
  readonly participant: string;
  readonly session: string;
  readonly generation?: import('./square-core.js').ActivityId;
};
