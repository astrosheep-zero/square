import { stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createArtifactPort } from './artifact.js';
import { presentPending } from './presentation-operations.js';
import { nativePendingPreview, nativePendingSource } from './inbox.js';
import { nativePendingHead, type NativePendingInput } from './delivery.js';
import { type WakeRoute } from './model.js';
import { parseActivityId } from './square-core.js';
import type { DeliveryEvidence, SeatRef, SquareArtifactPort, SquareRead, WakeOutcome, WakeRequest, WakeTransportPort } from './ports.js';
import { decodeHarnessOwner } from './owner.js';
import { indexedSquareEntries } from './square-index.js';
import { writeClaudeNative } from './packages/agent-delivery/src/claude-native.js';

const marker = /(?:^|\n)\[square-inbox:([a-zA-Z0-9-]+)\](?:\n|$)/g;
export function nativeTokens(text: string): string[] { return [...text.matchAll(marker)].map((match) => match[1]!); }
export function nativePayload(token: string, preview: string): string { return `[square-inbox:${token}]\n${preview}\n[/square-inbox:${token}]`; }
function nativeSupported(route: WakeRoute): boolean { return route.address.loaded === 'true' && !!route.address.endpoint; }
function hashPayload(payload: string): string { return createHash('sha256').update(payload).digest('hex'); }

interface NativePreview {
  readonly payload: string;
  readonly clipped: boolean;
}

function previewFacts(facts: import('./ports.js').SquareRead, request: WakeRequest): NativePreview | undefined {
  const index = parseActivityId(request.activity);
  if (index === undefined || request.route.kind !== 'claude-native' || request.route.address.endpoint === undefined) return undefined;
  return nativePendingPreview(facts, { location: request.location, participant: request.participant,
    generation: request.seat.generation, owner: request.seat.owner, index, route: request.route, now: Date.now() });
}

async function preview(artifact: SquareArtifactPort, request: WakeRequest): Promise<NativePreview | undefined> {
  return (await artifact.read((facts) => previewFacts(facts, request))).value;
}

async function writeClaudeWake(sessionId: string, endpoint: string, messageId: string, payload: string, timeoutMs: number, signal: AbortSignal): Promise<WakeOutcome> {
  const result = await writeClaudeNative({ sessionId, endpoint, messageId }, payload, { deadline: Date.now() + timeoutMs, signal });
  if (result.outcome === 'unavailable') return { outcome: 'failed', signature: 'claude_endpoint_unavailable', message: result.message };
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

async function dispatchClaude(request: WakeRequest, timeoutMs: number, beforeSend: () => Promise<boolean>, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome> {
  void env;
  const signal = AbortSignal.timeout(timeoutMs);
  if (!nativeSupported(request.route) || request.artifact === undefined || request.claimToken === undefined)
    return { outcome: 'not-capable', diagnostic: 'Claude native delivery needs a current artifact claim and loaded inbox.' };
  if (signal.aborted || !await beforeSend())
    return { outcome: 'unknown', signature: 'native_send_suppressed' };
  const prepared = await preview(request.artifact, request);
  if (prepared === undefined) return { outcome: 'not-capable', diagnostic: 'Claude activity is no longer current.' };
  const messageId = randomUUID();
  const payload = nativePayload(request.claimToken, prepared.payload);
  const correlation = { harness: 'claude' as const, token: request.claimToken, messageId, payloadHash: hashPayload(payload) };
  if (!await request.artifact.prepareDelivery({ seat: request.seat, claimToken: request.claimToken, correlation }))
    return { outcome: 'not-capable', diagnostic: 'Claude delivery claim is no longer current.' };
  const fresh = await preview(request.artifact, request);
  if (fresh === undefined || nativePayload(request.claimToken, fresh.payload) !== payload)
    return { outcome: 'not-capable', diagnostic: 'Claude activity changed before native write.' };
  if (signal.aborted || !await beforeSend()) return { outcome: 'not-capable', diagnostic: 'Claude activity was consumed before native write.' };
  const sessionId = request.route.address.sessionId;
  if (sessionId === undefined) return { outcome: 'not-capable', diagnostic: 'Claude native route has no session address.' };
  return writeClaudeWake(sessionId, request.route.address.endpoint!, messageId, payload, timeoutMs, signal);
}

interface NativeRow {
  readonly artifact: SquareArtifactPort;
  readonly evidence: DeliveryEvidence;
  readonly location: string;
  readonly index?: number;
  readonly seat?: SeatRef;
}

async function rowsForSession(sessionId: string, env: NodeJS.ProcessEnv, tokens: readonly string[]): Promise<NativeRow[]> {
  const rows: NativeRow[] = [];
  const candidates = (await indexedSquareEntries({}, env)).filter(entry => {
    const coordinate = decodeHarnessOwner(entry.owner);
    return coordinate?.channel === 'claude-code' && coordinate.session === sessionId;
  });
  const paths = new Set(candidates.map(candidate => candidate.location));
  for (const location of paths) {
    const artifact = createArtifactPort(location);
    try {
      const found = await artifact.read((facts) => tokens.flatMap((token): NativeRow[] => {
        const evidence = facts.deliveryByToken(token);
        if (evidence?.kind !== 'wake' || evidence.correlation?.harness !== 'claude' || evidence.correlation.token !== token
          || evidence.route?.kind !== 'claude-native' || evidence.route.address.sessionId !== sessionId) return [];
        const seat = facts.seat(evidence.participant);
        return [{ artifact, evidence, location, index: parseActivityId(evidence.activity),
          ...(seat === undefined ? {} : { seat: { participant: evidence.participant, owner: seat.owner, generation: evidence.generation } }) }];
      }));
      rows.push(...found.value);
      if (found.value.length === 0) await artifact.close();
    } catch { await artifact.close(); }
  }
  return rows;
}

/** The token, participant, activity and captured generation must still be the exact wake. */
function sameCapturedEvidence(facts: SquareRead, row: NativeRow): boolean {
  const token = row.evidence.claimToken;
  const evidence = token === undefined ? undefined : facts.deliveryByToken(token);
  return token !== undefined && evidence !== undefined && row.seat !== undefined && row.seat.participant === row.evidence.participant
    && row.seat.generation === row.evidence.generation && evidence.kind === 'wake' && evidence.claimToken === token
    && evidence.participant === row.evidence.participant && evidence.activity === row.evidence.activity
    && evidence.generation === row.evidence.generation
    && evidence.correlation?.harness === 'claude' && evidence.correlation.token === token
    && evidence.correlation.payloadHash === row.evidence.correlation?.payloadHash
    && ['dispatching', 'unknown', 'accepted'].includes(evidence.outcome);
}

function capturedInput(row: NativeRow, now: number): NativePendingInput | undefined {
  if (row.seat === undefined || row.index === undefined || row.evidence.route === undefined) return undefined;
  return { location: row.location, participant: row.evidence.participant, generation: row.seat.generation,
    owner: row.seat.owner, index: row.index, route: row.evidence.route, now };
}

function currentRow(facts: SquareRead, row: NativeRow, now: number): boolean {
  const input = capturedInput(row, now);
  return input !== undefined && sameCapturedEvidence(facts, row) && nativePendingHead(facts, input) !== undefined;
}

/** Recognize the whole frame first; one inactive token vetoes it before any evidence/receipt write. */
export async function observeClaudeDelivery(sessionId: string, text: string, operation: 'guard' | 'admitted' | 'stored', env: NodeJS.ProcessEnv = process.env): Promise<{ recognized: boolean; current: boolean }> {
  const tokens = nativeTokens(text);
  if (tokens.length === 0) return { recognized: false, current: false };
  const rows = await rowsForSession(sessionId, env, [...new Set(tokens)]);
  const recognized = rows.length > 0;
  const frames = [...text.matchAll(/(?:^|\n)(\[square-inbox:([a-zA-Z0-9-]+)\]\n[\s\S]*?\n\[\/square-inbox:\2\])(?=\n|$)/g)];
  try {
    // Every recognized token is vetted before any row can write: actual bytes against the
    // stored correlation hash, then independent current eligibility.
    const contentCurrent = rows.every(row => {
      const token = row.evidence.claimToken, hash = row.evidence.correlation?.payloadHash;
      if (token === undefined || hash === undefined || row.seat === undefined || row.index === undefined
        || !['dispatching', 'unknown', 'accepted'].includes(row.evidence.outcome)) return false;
      const matching = frames.filter(frame => frame[2] === token);
      return matching.length === tokens.filter(candidate => candidate === token).length
        && matching.every(frame => hashPayload(frame[1]) === hash);
    });
    if (!recognized || !contentCurrent) return { recognized, current: false };
    const now = Date.now();
    for (const row of rows) {
      if (!(await row.artifact.read(facts => currentRow(facts, row, now))).value) return { recognized, current: false };
    }
    for (const row of rows) {
      if (operation === 'guard') continue;
      const seat = row.seat!, index = row.index!;
      const current = (facts: SquareRead) => currentRow(facts, row, Date.now());
      const admitted = await row.artifact.transactAs({ kind: 'participant', seat }, facts =>
        current(facts) && facts.completeDelivery({ seat, activity: row.evidence.activity,
          claimToken: row.evidence.claimToken!, outcome: 'accepted', at: Date.now() })).catch(() => ({ value: false }));
      if (!admitted.value) return { recognized, current: false };
      if (operation === 'stored') {
        const input = capturedInput(row, Date.now());
        if (input === undefined || input.route.kind !== 'claude-native') return { recognized, current: false };
        const source = (await row.artifact.read(facts => sameCapturedEvidence(facts, row)
          ? nativePendingSource(facts, input) : undefined)).value;
        if (source === undefined) return { recognized, current: false };
        await presentPending({ artifact: row.artifact, location: row.location,
          // A sender preview is clipped coverage; only a full body consumes the stored message.
          participant: row.evidence.participant, activity: row.evidence.activity, seat, observationOf: row.evidence.claimToken,
          markSeen: !source.clipped, sink: { present() {} }, current });
      }
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
