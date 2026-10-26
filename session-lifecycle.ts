import { Square } from './square-api.js';
import type { Body } from './model.js';
import type { AutomaticProvider } from './participant-identity.js';
import { projectSessionBindings } from './inbox.js';

function bodyFor(provider: AutomaticProvider, sessionId: string): Body {
  return { channel: provider === 'claude' ? 'claude-code' : provider, session: sessionId };
}

/** Retire only seats held by this exact body, discovered through the rebuildable index. */
export async function endSessionMemberships(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const body = bodyFor(provider, sessionId);
  const bindings = await projectSessionBindings({ body, env });
  for (const binding of bindings) {
    const square = await Square.at({ path: binding.location, env, body, participant: binding.participant });
    try {
      await square.endOwnedSession(binding.participant, sessionId, binding.seat?.generation, body);
    } finally { await square.close(); }
  }
}
