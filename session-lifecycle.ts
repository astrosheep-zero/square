import { Square, withDefaultWakeTransport } from './square-api.js';
import { harnessOwner, type Owner } from './owner.js';
import type { AutomaticProvider } from './participant-identity.js';
import type { WakeAddress } from './model.js';
import { projectSessionCandidates, projectSessionSeats } from './inbox.js';

function ownerFor(provider: AutomaticProvider, sessionId: string): Owner {
  return harnessOwner({ channel: provider === 'claude' ? 'claude-code' : provider, session: sessionId });
}

/** Host shutdown suspends execution, not membership. Discovery never grants custody. */
export async function detachSessionSeats(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const owner = ownerFor(provider, sessionId);
  for (const { location, seat } of await projectSessionSeats({ owner, env })) {
    let square: Square | undefined;
    try {
      square = await Square.at(await withDefaultWakeTransport({ path: location, env }));
      await square.detach(seat.participant, { owner, generation: seat.generation });
    } catch { /* One unavailable or replaced seat must not block cleanup of the others. */ }
    finally { await square?.close(); }
  }
}

/** Restore only detached, standing seats of this exact owner before starting a receiver. */
export async function restoreSessionSeats(owner: Owner, env: NodeJS.ProcessEnv = process.env, wakeAddress?: WakeAddress, signal?: AbortSignal): Promise<void> {
  const locations = new Set((await projectSessionCandidates({ owner, env })).map(candidate => candidate.location));
  for (const location of locations) {
    if (signal?.aborted) return;
    let square: Square | undefined;
    try {
      square = await Square.at(await withDefaultWakeTransport({ path: location, env }), { signal });
      for (const seat of await square.seatsOf(owner)) {
        if (signal?.aborted) return;
        if (seat.attachment !== 'detached') continue;
        try { await square.reattach(seat.name, { owner, wakeAddress }, { signal }); }
        catch { /* A replacement or one failed seat does not block its peers. */ }
      }
    } catch { /* An indexed location is only a candidate, not a promise of availability. */ }
    finally { await square?.close(); }
  }
}
