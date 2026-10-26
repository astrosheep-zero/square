import { operationEnv } from './participant-identity.js';
import { openSquare } from './open-square.js';
import { closeOpenSquare } from './open-square.js';
import { recordClaudeDeliveryStatus, type ClaudeDeliveryStatus } from './claude-delivery-status.js';
import { Square } from './square-api.js';
import { observeClaudeDelivery, type ClaudeBinding } from './claude-delivery.js';
import { processActNotificationsOnce } from './notifications.js';
import { sweepPending } from './delivery-operations.js';
import { beginClaudeMcpCall, endClaudeMcpCall } from './claude-mcp-context.js';
import { asSeatRef } from './seats.js';
import { projectSessionBindings, projectSessionCandidates } from './inbox.js';

export interface ClaudeCoordinate { readonly sessionId: string; readonly cwd: string; readonly version: string; readonly endpoint?: string }
interface ClaudeBridgeInput extends ClaudeCoordinate {
  readonly operation: 'start' | 'reconcile' | 'end' | 'cancel' | 'guard' | 'admitted' | 'stored' | 'tool-begin' | 'tool-end' | 'status';
  readonly status?: ClaudeDeliveryStatus;
  readonly toolUseId?: string;
  readonly agentId?: string;
  readonly token?: string;
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
  if (input.operation === 'status') {
    const recorded = input.status?.sessionId === input.sessionId && await recordClaudeDeliveryStatus(input.status, env);
    return `${JSON.stringify({ recorded })}\n`;
  }
  if (input.operation === 'tool-begin') {
    return `${JSON.stringify(await beginClaudeMcpCall({ toolUseId: input.toolUseId!, sessionId: input.sessionId, cwd: input.cwd, agentId: input.agentId }, env))}\n`;
  }
  if (input.operation === 'tool-end') {
    await endClaudeMcpCall(input.toolUseId!, input.token!, env);
    return '{}\n';
  }
  const scoped = operationEnv('claude', input.sessionId, env);
  const signal = AbortSignal.timeout(2500);
  const body = { channel: 'claude-code', session: input.sessionId, ...(input.agentId === undefined ? {} : { agent: input.agentId }) };
  const supported = process.platform === 'darwin' && typeof input.endpoint === 'string' && input.endpoint.startsWith('/');
  const sessionBindings = async () => (await projectSessionBindings({ body, env }))
    .filter((row) => row.seat !== undefined)
    .map((row) => ({ row, binding: {
      location: row.location, participant: row.participant, session: row.sessionId, generation: row.seat!.generation,
    } }));
  if (input.operation === 'end') {
    const retired: ClaudeBinding[] = [];
    const captured = [...input.bindings ?? []];
    // Discover committed late joins at the pinned end boundary, never later owners.
    if (input.endedAt !== undefined) for (const { row, binding } of await sessionBindings()) {
      if (row.updatedAt > input.endedAt || captured.some((item) => item.location === binding.location
        && item.participant === binding.participant && item.generation === binding.generation)) continue;
      captured.push(binding);
    }
    for (const binding of captured) {
      if (binding.session !== input.sessionId) continue;
      const square = await Square.at({ path: binding.location, env: scoped, body,
        participant: binding.participant });
      try {
        const ended = await square.endOwnedSession(binding.participant, input.sessionId, binding.generation, body);
        if (ended?.activity) retired.push({ ...binding, generation: binding.generation });
      } finally { await square.close(); }
      if (signal.aborted) break;
    }
    return `${JSON.stringify({ retired })}\n`;
  }
  const recovery = new Set<string>();
  const cancelledBindings = [...input.cancelledBindings ?? []];
  if (input.operation === 'start' && input.resume) {
    // Resume is proven by the artifact's latest participant lifecycle, while HOME
    // contributes only candidate paths. A stale candidate never establishes a seat.
    const candidates = await projectSessionCandidates({ body, env });
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (signal.aborted) break;
      const probe = await openSquare(candidate.location, { body: candidate.body, signal });
      let names: string[];
      try {
        names = (await probe.artifact.read(facts => facts.completedSeatsForBody(body).map(seat => seat.participant), signal)).value;
      } finally { await closeOpenSquare(probe); }
      for (const participant of names) {
        const key = `${candidate.location}\0${participant}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const square = await Square.at({ path: candidate.location, env: scoped, body, participant });
        try { await square.join(participant); }
        finally { await square.close(); }
      }
    }
  }
  if (input.operation === 'start' || input.operation === 'reconcile' || input.operation === 'cancel' || input.cancelAt !== undefined) {
    for (const { row, binding } of await sessionBindings()) {
      if (signal.aborted) break;
      const matches = (item: ClaudeBinding | undefined) => item !== undefined
        && item.location === binding.location && item.participant === binding.participant && item.session === input.sessionId
        && (item.generation === undefined || item.generation === binding.generation);
      const expected = input.bindings?.find(matches);
      const cancelled = input.cancelledBindings?.find(matches) ?? (input.operation === 'cancel' ? expected : undefined);
      const lateCancelledJoin = input.operation === 'cancel' && input.cancelAt !== undefined
        && row.updatedAt <= input.cancelAt && expected === undefined;
      if (lateCancelledJoin && !cancelledBindings.some(matches)) cancelledBindings.push(binding);
      if (input.operation !== 'start' && input.operation !== 'reconcile' && !lateCancelledJoin && expected === undefined) continue;
      const square = await openSquare(binding.location, { body, signal });
      try {
        const { value: currentSeat } = await square.artifact.read((facts) => facts.seat(binding.participant), signal);
        if (currentSeat === undefined || currentSeat.generation !== binding.generation
          || currentSeat.body.session !== input.sessionId || currentSeat.body.channel !== 'claude-code') continue;
        const seat = asSeatRef(currentSeat);
        const existing = currentSeat.wakeAddress?.kind === 'claude-native' ? currentSeat.wakeAddress : undefined;
        const cutoff = input.cancelAt !== undefined && (cancelled !== undefined || lateCancelledJoin) ? input.cancelAt : undefined;
        if (cutoff !== undefined) {
          const { value: through } = await square.artifact.read((facts) => {
            let beforeIndex: number | undefined;
            for (;;) {
              const page = facts.activityHeads({ beforeIndex }, { edge: 'newest', limit: 100 });
              const last = [...page.items].reverse().find((activity) => activity.at <= cutoff);
              if (last !== undefined) return last.index;
              if (!page.hasMore) return -1;
              beforeIndex = page.items[0].index;
            }
          }, signal);
          if (through >= 0) await square.artifact.cancelDeliveries(seat, through, signal);
        }
        if (!supported) {
          if (existing !== undefined) await square.artifact.transactAs({ kind: 'participant', seat }, (facts) => facts.updateWakeAddress(seat, undefined), signal);
          continue;
        }
        if (existing === undefined || existing.address.endpoint !== input.endpoint) recovery.add(binding.location);
        await square.artifact.transactAs({ kind: 'participant', seat }, (facts) => facts.updateWakeAddress(seat, {
          kind: 'claude-native', address: { sessionId: input.sessionId, endpoint: input.endpoint!, version: input.version, platform: 'darwin', loaded: 'true' },
        }), signal);
      } finally { await closeOpenSquare(square); }
    }
  }
  if (input.operation === 'start' || input.operation === 'reconcile' || input.operation === 'cancel') {
    const bindings = (await sessionBindings()).map(({ binding }) => binding);
    // One startup recovery pass for known unsent work. Unknown/admitted sends never replay.
    if (supported && input.operation !== 'cancel') for (const binding of bindings) {
      if (signal.aborted) break;
      if (input.operation !== 'start' && !recovery.has(binding.location)) continue;
      const square = await openSquare(binding.location, { body, signal });
      let indices: number[];
      try { indices = await sweepPending({ artifact: square.artifact, location: binding.location, now: Date.now(), graceMs: 0, limit: 8 }); }
      finally { await closeOpenSquare(square); }
      for (const index of indices) { if (signal.aborted) break; await processActNotificationsOnce(binding.location, index, { env: { ...env, SQUARE_NOTIFY_DELIVERY_WAIT_MS: '200' } }); }
    }
    return `${JSON.stringify({ available: supported, diagnostic: supported ? undefined : 'Native inbox unavailable: requires macOS Claude with an interactive loaded mod and its real endpoint.', bindings, cancelledBindings })}\n`;
  }
  if (!['guard', 'admitted', 'stored'].includes(input.operation) || typeof input.text !== 'string') throw new Error('Unknown Claude bridge operation.');
  return `${JSON.stringify(await observeClaudeDelivery(input.sessionId, input.text, input.operation as 'guard' | 'admitted' | 'stored', env))}\n`;
}
