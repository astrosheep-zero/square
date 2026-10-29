import { Square } from './square-api.js';
import type { Body, WakeAddress } from './model.js';
import type { AutomaticProvider } from './participant-identity.js';
import { projectSessionCandidates, projectSessionSeats } from './inbox.js';

function bodyFor(provider: AutomaticProvider, sessionId: string): Body {
  return { channel: provider === 'claude' ? 'claude-code' : provider, session: sessionId };
}

/** Host shutdown suspends execution, not membership. Discovery never grants custody. */
export async function detachSessionSeats(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const body = bodyFor(provider, sessionId);
  for (const { location, seat } of await projectSessionSeats({ body, env })) {
    let square: Square | undefined;
    try {
      square = await Square.at({ path: location, env, body });
      await square.detachOwnedSession(seat.participant, sessionId, seat.generation, body);
    } catch { /* One unavailable or replaced seat must not block cleanup of the others. */ }
    finally { await square?.close(); }
  }
}

/** Restore only detached, standing seats of this exact Body before starting a receiver. */
export async function restoreSessionSeats(body: Body, env: NodeJS.ProcessEnv = process.env, wakeAddress?: WakeAddress, signal?: AbortSignal): Promise<void> {
  const locations = new Set((await projectSessionCandidates({ body, env })).map(candidate => candidate.location));
  for (const location of locations) {
    if (signal?.aborted) return;
    let square: Square | undefined;
    try {
      square = await Square.at({ path: location, env, body, wakeAddress }, { signal });
      for (const seat of await square.bodySeats()) {
        if (signal?.aborted) return;
        if (seat.attachment !== 'detached') continue;
        // Unlike explicit join, implicitJoin never revives a done that raced this read.
        try { await square.implicitJoin(seat.participant, { signal }); }
        catch { /* A replacement or one failed seat does not block its peers. */ }
      }
    } catch { /* An indexed location is only a candidate, not a promise of availability. */ }
    finally { await square?.close(); }
  }
}
