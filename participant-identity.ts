import { createHash } from 'node:crypto';

import { validateName } from './model.js';

export function participantIdentity(name: string): string {
  return `@${name}`;
}

export type AutomaticProvider = 'codex' | 'claude' | 'opencode' | 'pi';

/** Channels a harness coordinate can map to. `unknown` stays a process-level fallback, not a coordinate. */
export type HarnessSessionChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo';

export type HarnessSessionVariable =
  | 'CLAUDE_CODE_SESSION_ID'
  | 'CODEX_THREAD_ID'
  | 'OPENCODE_SESSION_ID'
  | 'PI_SESSION_ID'
  | 'PASEO_AGENT_ID';

/**
 * Ordered harness environment coordinates. This one table is the mapping owner every consumer
 * derives from; `provider` is absent for a coordinate without an automatic participant provider.
 */
export interface HarnessSessionSource {
  readonly variable: HarnessSessionVariable;
  readonly channel: HarnessSessionChannel;
  readonly provider?: AutomaticProvider;
  readonly childVariable?: 'CLAUDE_CODE_CHILD_SESSION';
}

export const harnessSessionSources: readonly HarnessSessionSource[] = [
  { variable: 'CLAUDE_CODE_SESSION_ID', channel: 'claude-code', provider: 'claude', childVariable: 'CLAUDE_CODE_CHILD_SESSION' },
  { variable: 'CODEX_THREAD_ID', channel: 'codex', provider: 'codex' },
  { variable: 'OPENCODE_SESSION_ID', channel: 'opencode', provider: 'opencode' },
  { variable: 'PI_SESSION_ID', channel: 'pi', provider: 'pi' },
  { variable: 'PASEO_AGENT_ID', channel: 'paseo' },
];

/** Raw nonempty harness session ids in table order. Duplicates are preserved, never collapsed. */
export function sessionIdsFromEnvironment(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return harnessSessionSources
    .map((source) => env[source.variable]?.trim())
    .filter((value): value is string => Boolean(value));
}

/** The first nonempty harness coordinate in table order, or undefined when none is set. */
export function firstHarnessSession(env: NodeJS.ProcessEnv = process.env): { readonly sessionId: string; readonly channel: HarnessSessionChannel } | undefined {
  for (const source of harnessSessionSources) {
    const sessionId = env[source.variable]?.trim();
    if (sessionId) return { sessionId, channel: source.channel };
  }
  return undefined;
}

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
  // Every native provider contributes its own name without deduping session ids first: equal ids
  // in different providers are different coordinates and must stay ambiguous.
  const names = new Set<string>();
  for (const source of harnessSessionSources) {
    if (source.provider === undefined) continue;
    const sessionId = env[source.variable]?.trim();
    if (!sessionId) continue;
    names.add(automaticParticipant(source.provider, sessionId, env));
  }
  return names.size === 1 ? [...names][0] : undefined;
}
