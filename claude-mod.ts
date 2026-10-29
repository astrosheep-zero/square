import { operationEnv } from './participant-identity.js';
import { createArtifactPort } from './artifact.js';
import { recordClaudeDeliveryStatus, type ClaudeDeliveryStatus } from './claude-delivery-status.js';
import { Square } from './square-api.js';
import { observeClaudeDelivery, type ClaudeBinding } from './claude-delivery.js';
import { processActNotificationsOnce } from './notifications.js';
import { sweepPending } from './delivery-operations.js';
import { beginClaudeMcpCall, endClaudeMcpCall } from './claude-mcp-context.js';
import { asSeatRef } from './seats.js';
import { projectSessionSeats } from './inbox.js';
import { restoreSessionSeats } from './session-lifecycle.js';
import { InternalSquareError, SquareError, sameBody, type LocatedSeat } from './model.js';

/** Persisted hook state keeps its wire coordinate; internal consumers keep the located seat. */
function claudeBinding({ location, seat }: LocatedSeat): ClaudeBinding {
  return { location, participant: seat.participant, session: seat.body.session, generation: seat.generation };
}

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
  const sessionSeats = async () => (await projectSessionSeats({ body, env }, signal)).filter(member => member.seat.attachment === 'attached');
  if (input.operation === 'end') {
    const retired: ClaudeBinding[] = [];
    const captured = [...input.bindings ?? []];
    // Discover committed late joins at the pinned end boundary, never later owners.
    if (input.endedAt !== undefined) for (const member of await projectSessionSeats({ body, env }, signal)) {
      if (member.joinedAt > input.endedAt || captured.some((item) => item.location === member.location
        && item.participant === member.seat.participant && item.generation === member.seat.generation)) continue;
      captured.push(claudeBinding(member));
    }
    for (const binding of captured) {
      if (binding.session !== input.sessionId) continue;
      const square = await Square.at({ path: binding.location, env: scoped, body,
        participant: binding.participant });
      try {
        const detached = await square.detachOwnedSession(binding.participant, input.sessionId, binding.generation, body);
        if (detached) retired.push(binding);
      } finally { await square.close(); }
      if (signal.aborted) break;
    }
    return `${JSON.stringify({ retired })}\n`;
  }
  const recovery = new Set<string>();
  const cancelledBindings = [...input.cancelledBindings ?? []];
  if (input.operation === 'start') {
    await restoreSessionSeats(body, scoped, supported ? {
      kind: 'claude-native', address: { sessionId: input.sessionId, endpoint: input.endpoint!, version: input.version, platform: 'darwin', loaded: 'true' },
    } : undefined, signal);
  }
  if (input.operation === 'start' || input.operation === 'reconcile' || input.operation === 'cancel' || input.cancelAt !== undefined) {
    for (const member of await sessionSeats()) {
      if (signal.aborted) break;
      const { location, seat: capturedSeat, joinedAt } = member;
      const matches = (item: ClaudeBinding | undefined) => item !== undefined
        && item.location === location && item.participant === capturedSeat.participant && item.session === capturedSeat.body.session
        && (item.generation === undefined || item.generation === capturedSeat.generation);
      const expected = input.bindings?.find(matches);
      const cancelled = input.cancelledBindings?.find(matches) ?? (input.operation === 'cancel' ? expected : undefined);
      const lateCancelledJoin = input.operation === 'cancel' && input.cancelAt !== undefined
        && joinedAt <= input.cancelAt && expected === undefined;
      if (lateCancelledJoin && !cancelledBindings.some(matches)) cancelledBindings.push(claudeBinding(member));
      if (input.operation !== 'start' && input.operation !== 'reconcile' && !lateCancelledJoin && expected === undefined) continue;
      const artifact = createArtifactPort(location, undefined, signal);
      try {
        const { value: currentSeat } = await artifact.read((facts) => facts.seat(capturedSeat.participant), signal);
        if (currentSeat === undefined || currentSeat.attachment !== 'attached' || currentSeat.generation !== capturedSeat.generation
          || !sameBody(currentSeat.body, capturedSeat.body)) continue;
        const seat = asSeatRef(currentSeat);
        const existing = currentSeat.wakeAddress?.kind === 'claude-native' ? currentSeat.wakeAddress : undefined;
        const cutoff = input.cancelAt !== undefined && (cancelled !== undefined || lateCancelledJoin) ? input.cancelAt : undefined;
        if (cutoff !== undefined) {
          const { value: through } = await artifact.read((facts) => {
            let beforeIndex: number | undefined;
            for (;;) {
              const page = facts.activityHeads({ beforeIndex }, { edge: 'newest', limit: 100 });
              const last = [...page.items].reverse().find((activity) => activity.at <= cutoff);
              if (last !== undefined) return last.index;
              if (!page.hasMore) return -1;
              beforeIndex = page.items[0].index;
            }
          }, signal);
          if (through >= 0) await artifact.cancelDeliveries(seat, through, signal);
        }
        if (!supported) {
          if (existing !== undefined) await artifact.transactAs({ kind: 'participant', seat }, (facts) => facts.updateWakeAddress(seat, undefined), signal);
          continue;
        }
        if (existing === undefined || existing.address.endpoint !== input.endpoint) recovery.add(location);
        await artifact.transactAs({ kind: 'participant', seat }, (facts) => facts.updateWakeAddress(seat, {
          kind: 'claude-native', address: { sessionId: input.sessionId, endpoint: input.endpoint!, version: input.version, platform: 'darwin', loaded: 'true' },
        }), signal);
      } catch (error) {
        if (error instanceof InternalSquareError && error.code === 'not_found')
          throw new SquareError('unavailable', `Square is unavailable at ${location}`);
        throw error;
      } finally { await artifact.close(); }
    }
  }
  if (input.operation === 'start' || input.operation === 'reconcile' || input.operation === 'cancel') {
    const members = await sessionSeats();
    // One startup recovery pass for known unsent work. Unknown/admitted sends never replay.
    if (supported && input.operation !== 'cancel') for (const { location } of members) {
      if (signal.aborted) break;
      if (input.operation !== 'start' && !recovery.has(location)) continue;
      const artifact = createArtifactPort(location, undefined, signal);
      let indices: number[];
      try { indices = await sweepPending({ artifact, location, now: Date.now(), graceMs: 0, limit: 8 }); }
      catch (error) {
        if (error instanceof InternalSquareError && error.code === 'not_found')
          throw new SquareError('unavailable', `Square is unavailable at ${location}`);
        throw error;
      } finally { await artifact.close(); }
      for (const index of indices) { if (signal.aborted) break; await processActNotificationsOnce(location, index, { env: { ...env, SQUARE_NOTIFY_DELIVERY_WAIT_MS: '200' } }); }
    }
    return `${JSON.stringify({ available: supported, diagnostic: supported ? undefined : 'Native inbox unavailable: requires macOS Claude with an interactive loaded mod and its real endpoint.', bindings: members.map(claudeBinding), cancelledBindings })}\n`;
  }
  if (!['guard', 'admitted', 'stored'].includes(input.operation) || typeof input.text !== 'string') throw new Error('Unknown Claude bridge operation.');
  return `${JSON.stringify(await observeClaudeDelivery(input.sessionId, input.text, input.operation as 'guard' | 'admitted' | 'stored', env))}\n`;
}
