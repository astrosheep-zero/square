import { createHash } from 'node:crypto';

import { validateName } from './model.js';

export function participantIdentity(name: string): string {
  return `@${name}`;
}

export type AutomaticProvider = 'codex' | 'claude' | 'opencode' | 'pi';

const nativeSessions: ReadonlyArray<{
  variable: 'CLAUDE_CODE_SESSION_ID' | 'CODEX_THREAD_ID' | 'OPENCODE_SESSION_ID' | 'SQUARE_PI_SESSION_ID';
  provider: AutomaticProvider;
}> = [
  { variable: 'CLAUDE_CODE_SESSION_ID', provider: 'claude' },
  { variable: 'CODEX_THREAD_ID', provider: 'codex' },
  { variable: 'OPENCODE_SESSION_ID', provider: 'opencode' },
  { variable: 'SQUARE_PI_SESSION_ID', provider: 'pi' },
];

export function automaticParticipant(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv): string {
  const configured = env.SQUARE_PARTICIPANT_NAME?.trim();
  if (configured) {
    validateName(configured);
    return configured;
  }
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 12);
  return `${provider}-${digest}`;
}

/** Compute the current harness participant without reading a Square or registry artifact. */
export function squareAssignedParticipantName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.SQUARE_PARTICIPANT_NAME?.trim();
  if (configured) {
    validateName(configured);
    return configured;
  }
  const names = new Set(
    nativeSessions
      .map(({ variable, provider }) => {
        const sessionId = env[variable]?.trim();
        return sessionId === undefined || sessionId === '' ? undefined : automaticParticipant(provider, sessionId, env);
      })
      .filter((name): name is string => name !== undefined),
  );
  return names.size === 1 ? [...names][0] : undefined;
}
