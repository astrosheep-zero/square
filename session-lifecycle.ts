import { Square } from './square-api.js';
import { operationEnv, type AutomaticProvider } from './participant-identity.js';
import { hostLedgerForEnv } from './registry.js';
import { projectSessionBindings } from './square-projections.js';

/** Retire only memberships owned at this session's end, regardless of square filename or cwd. */
export async function endSessionMemberships(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const scoped = operationEnv(provider, sessionId, env);
  const hostLedger = hostLedgerForEnv(scoped);
  const bindings = await projectSessionBindings({ hostLedger, sessionId });
  for (const binding of bindings) {
    const square = await Square.at({ path: binding.location, hostLedger, env: scoped });
    try {
      // The captured epoch fences a same-session rejoin as well as a foreign takeover.
      // endOwnedSession also settles routes and presence under the ownership claim lock.
      await square.endOwnedSession(binding.participant, sessionId, binding.epoch ?? 0);
    } finally { await square.close(); }
  }
}
