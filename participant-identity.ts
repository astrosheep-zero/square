import { akumaDeliveryOwner, requireAkumaActor, type AkumaActor, type Owner } from './owner.js';
import type { WakeAddress } from './square-values.js';

export type { AkumaActor } from './owner.js';

/** Use only at a boundary whose process represents one actual invoking actor. */
export function akumaActorFromEnvironment(env: NodeJS.ProcessEnv): AkumaActor | undefined {
  // A Claude subagent can inherit its parent's environment; that proves nothing about the child.
  if (env.CLAUDE_CODE_CHILD_SESSION === '1') return undefined;
  const { KEIYAKU_ACTOR_WORLD: world, KEIYAKU_ACTOR_ID: akuId } = env;
  return world === undefined && akuId === undefined ? undefined : requireAkumaActor({ world, akuId });
}

/** A complete actor binding replaces the native pair, never just its owner or its route. */
export function resolveParticipantIdentity<T>(
  actor: AkumaActor | undefined, native: () => T,
): T | { owner: Owner; wakeAddress: WakeAddress } {
  if (actor === undefined) return native();
  const address = requireAkumaActor(actor);
  return { owner: akumaDeliveryOwner(address), wakeAddress: { kind: 'keiyaku', address: { ...address } } };
}

interface ActorRequestBus {
  emit(topic: string, request: { reply(pair: unknown): void }): void;
}

/** A reply is invocation-local, synchronous and unambiguous, or there is no usable binding. */
export function requestPiAkumaActor(bus: ActorRequestBus | undefined): AkumaActor | undefined {
  let replies = 0, pair: AkumaActor | undefined, invalid = false, open = true;
  try {
    bus?.emit('keiyaku:actor:request', { reply(value) {
      if (!open) return;
      replies++;
      try { pair = requireAkumaActor(value); } catch { invalid = true; }
    } });
  } finally { open = false; }
  if (replies > 1 || invalid) throw new Error('Invalid or ambiguous Keiyaku actor identity for this Pi call.');
  return pair;
}

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
