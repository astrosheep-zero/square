import { Square } from './square-api.js';
import type { Body } from './model.js';
import type { AutomaticProvider } from './participant-identity.js';
import { projectSessionSeats } from './inbox.js';

function bodyFor(provider: AutomaticProvider, sessionId: string): Body {
  return { channel: provider === 'claude' ? 'claude-code' : provider, session: sessionId };
}

/** Retire only seats held by this exact body, discovered through the rebuildable index. */
export async function endSessionMemberships(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const body = bodyFor(provider, sessionId);
  const seats = await projectSessionSeats({ body, env });
  for (const { location, seat } of seats) {
    const square = await Square.at({ path: location, env, body, participant: seat.participant });
    try {
      await square.endOwnedSession(seat.participant, sessionId, seat.generation, body);
    } finally { await square.close(); }
  }
}
