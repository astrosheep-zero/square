import { createArtifactPort } from './artifact.js';
import { presentPending } from './presentation-operations.js';
import { nativePendingHead, type NativePendingInput } from './delivery.js';
import type { DeliveryEvidence, SeatRef, SquareArtifactPort, SquareRead } from './ports.js';
import { decodeHarnessOwner } from './owner.js';
import { indexedSquareEntries } from './square-index.js';
import { parseMessageId } from './message.js';

export { createClaudeWakeTransport, nativeTokens, nativePayload } from './claude-transport.js';
import { nativeTokens, hashPayload } from './claude-transport.js';

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
        return [{ artifact, evidence, location, index: parseMessageId(evidence.message),
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
    && evidence.participant === row.evidence.participant && evidence.message === row.evidence.message
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
      const seat = row.seat!;
      const current = (facts: SquareRead) => currentRow(facts, row, Date.now());
      const admitted = await row.artifact.transactAs({ kind: 'participant', seat }, facts =>
        current(facts) && facts.channel.completeDelivery({ seat, message: row.evidence.message,
          claimToken: row.evidence.claimToken!, outcome: 'accepted', at: Date.now() })).catch(() => ({ value: false }));
      if (!admitted.value) return { recognized, current: false };
      if (operation === 'stored') {
        await presentPending({ artifact: row.artifact, location: row.location,
          // Persisted coverage decides consumption; the current renderer never guesses.
          participant: row.evidence.participant, message: row.evidence.message, seat, observationOf: row.evidence.claimToken,
          markSeen: row.evidence.coverage !== 'clipped', sink: { present() {} }, current });
      }
    }
    return { recognized, current: true };
  } finally { await Promise.all([...new Set(rows.map(row => row.artifact))].map(artifact => artifact.close())); }
}

export type ClaudeBinding = {
  readonly location: string;
  readonly participant: string;
  readonly session: string;
  readonly generation?: string;
};
