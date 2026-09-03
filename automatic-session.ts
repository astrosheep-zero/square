import { promises as fs } from 'node:fs';
import path from 'node:path';

import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { Square } from './square-wiring.js';
import { entryPresentation } from './views.js';
import { automaticParticipant } from './participant-identity.js';
import { SquareError } from './model.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import { projectSessionBindings } from './square-projections.js';
import type { PresenceRecord } from './host-ledger.js';
import { claimSessionParticipant, readParticipantOwner, releaseSessionParticipant } from './registry.js';
import { done as doneAction } from './square-actions.js';
import { publishWakeRoute, retireWakeRouteFromArtifact, resolvePrimaryWakeRoute, defaultWakeRouteCapabilities } from './routes.js';

export type AutomaticProvider = 'codex' | 'claude' | 'opencode' | 'pi';

export { automaticParticipant } from './participant-identity.js';

const providerEnv: Record<AutomaticProvider, string> = {
  codex: 'CODEX_THREAD_ID',
  claude: 'CLAUDE_CODE_SESSION_ID',
  opencode: 'OPENCODE_SESSION_ID',
  pi: 'SQUARE_PI_SESSION_ID',
};

function operationEnv(provider: AutomaticProvider, sessionId: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_CHILD_SESSION: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    SQUARE_PI_SESSION_ID: '',
    // Keep Paseo for wake preference; native provider session wins claim identity below.
    [providerEnv[provider]]: sessionId,
  };
}

function hostLedgerForEnv(env: NodeJS.ProcessEnv) {
  const root = env.SQUARE_REGISTRY === undefined ? undefined : path.dirname(env.SQUARE_REGISTRY);
  return createHostLedgerPort({
    userPath: env.SQUARE_HOST_LEDGER_USER ?? root,
    localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? root,
  });
}

export function publicSquarePath(cwd: string): string {
  return path.join(cwd, '.square', 'PUBLIC.square');
}

async function squareExists(squarePath: string): Promise<boolean> {
  try {
    await fs.access(squarePath);
    return true;
  } catch {
    return false;
  }
}

export async function automaticSessionStart(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const squarePath = publicSquarePath(cwd);
  if (!await squareExists(squarePath)) return undefined;
  let reader;
  try {
    reader = await openSquare(squarePath);
  } catch (error) {
    process.stderr.write(`! PUBLIC.square unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
  const name = automaticParticipant(provider, sessionId, env);
  const hostLedger = hostLedgerForEnv(env);
  let bindings: readonly PresenceRecord[];
  let entry: Awaited<ReturnType<typeof entryPresentation>>;
  try {
    bindings = await hostLedger.listPresence({ location: squarePath, participant: name, scopes: ['user', 'local'] });
    entry = await entryPresentation(reader, name);
  } finally {
    await closeOpenSquare(reader);
  }
  if (bindings.some((binding) => binding.session !== sessionId)) {
    throw new SquareError('already_joined', `${name} is already bound to another session`);
  }
  if (entry.joined && !bindings.some((binding) => binding.session === sessionId)) {
    throw new SquareError('already_joined', `${name} is already joined by another session`);
  }
  const scopedEnv = operationEnv(provider, sessionId, env);
  const claim = await claimSessionParticipant(squarePath, name, scopedEnv);
  const square = await Square.at({ path: squarePath, hostLedger: hostLedgerForEnv(scopedEnv), env: scopedEnv });
  try {
    const implicit = await square.implicitJoin(name);
    if (implicit.state === 'done') {
      if (claim?.status === 'acquired') await releaseSessionParticipant(squarePath, name, scopedEnv);
      return undefined;
    }
    const route = resolvePrimaryWakeRoute({ location: squarePath, participant: name, sessionId, provider }, env, await defaultWakeRouteCapabilities(hostLedgerForEnv(env)));
    if (route !== undefined) {
      const publisher = await openSquare(squarePath, { hostLedger: hostLedgerForEnv(scopedEnv), env: scopedEnv });
      try {
        await publishWakeRoute(
          publisher.artifact,
          { ...route, ...(claim?.epoch === undefined || claim.epoch <= 0 ? {} : { epoch: claim.epoch }) },
          { at: Date.now() },
        );
      } finally { await closeOpenSquare(publisher); }
    }
    await hostLedgerForEnv(env).ensurePresence({
      location: squarePath,
      participant: name,
      session: sessionId,
      channel: provider === 'claude' ? 'claude-code' : provider,
      updatedAt: Date.now(),
      ...(claim?.epoch === undefined || claim.epoch <= 0 ? {} : { epoch: claim.epoch }),
    } as PresenceRecord & { epoch?: number }, 'user');
    await square.reconcileBinding();
    return undefined;
  } catch (error) {
    if (claim?.status === 'acquired') await releaseSessionParticipant(squarePath, name, scopedEnv).catch(() => undefined);
    throw error;
  } finally {
    await square.close();
  }
}

export async function automaticSessionEnd(provider: AutomaticProvider, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const squarePath = publicSquarePath(cwd);
  const scopedEnv = operationEnv(provider, sessionId, env);
  const hostLedger = hostLedgerForEnv(scopedEnv);
  const probe = await openSquare(squarePath, { hostLedger, env: scopedEnv });
  const binding = (await projectSessionBindings({
    hostLedger,
    sessionId,
    location: probe.location,
    scopes: ['user', 'local'],
  }))[0];
  const expectedEpoch = binding === undefined
    ? undefined
    : (await readParticipantOwner(squarePath, binding.participant, scopedEnv))?.epoch;
  await closeOpenSquare(probe);
  if (binding === undefined || !await squareExists(squarePath)) return;
  const reader = await openSquare(squarePath);
  const joined = await entryPresentation(reader, binding.participant).finally(() => closeOpenSquare(reader));
  if (!joined.joined) return;
  const opened = await openSquare(squarePath, { hostLedger: hostLedgerForEnv(scopedEnv), env: scopedEnv });
  try {
    try {
      await doneAction(opened, binding.participant, '', expectedEpoch === undefined ? {} : { expectedEpoch });
    } catch (error) {
      if (!(error instanceof SquareError && error.code === 'already_done')) throw error;
    }
    try { await hostLedger.reconcileBinding({ artifact: opened.artifact }); } catch { /* best effort */ }
    await retireWakeRouteFromArtifact(
      opened.artifact,
      { location: squarePath, participant: binding.participant, sessionId },
      expectedEpoch === undefined ? {} : { expectedEpoch },
    );
  } finally {
    await closeOpenSquare(opened);
  }
}
