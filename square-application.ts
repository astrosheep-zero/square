import fs from 'node:fs';
import path from 'node:path';

import { emptyRuntimeState, loadRuntimeSidecar, loadSquare, mergeRuntimeState, renderArtifactAct, renderSquare, renderSquareDoc, saveRuntimeSidecar } from './artifact.js';
import { type Act } from './square-core.js';
import { coreCompact, coreDone, coreHold, coreResume, decideAct, decideJoin, resolveKnownName } from './decisions.js';
import { planRepair, type PlanRepairResult } from './doctor.js';
import { withFileLock } from './file-lock.js';
import { stageReplacement, type StagedReplacement } from './harness-stage.js';
import { SquareError, type BuildOptions, type HardCap, type Reach, type SquareDoc, type StoredAct, type WakeRouteKind } from './model.js';
import { advanceCursor, freshWatchLease, LOCK_RETRY_MS, LOCK_STALE_MS, removeWatchLease, touchPresenceCursor, watchLease, writeWatchLease } from './runtime.js';

export interface CommitPlan<Result> {
  result: Result;
  acts: Act[];
  replaceDoc?: SquareDoc;
  mutateRuntime?: (doc: SquareDoc) => void;
  preparePersistence?: () => StagedReplacement;
}

export type Intent =
  | { type: 'join'; name: string; now: number }
  | { type: 'say'; name: string; body: string; force: boolean; now: number; reach?: Reach; reply?: number }
  | { type: 'hold'; actor: string; body: string; now: number }
  | { type: 'resume'; actor: string; now: number }
  | { type: 'done'; name: string; body: string; now: number }
  | { type: 'lease'; name: string; leaseId: string; at: number; expiresAt: number; ownerId?: string; force?: boolean; filter?: { participants?: string[]; mention?: string } }
  | { type: 'release-lease'; name: string; leaseId: string }
  | { type: 'claim-notify'; key: string; leaseId: string; at: number; expiresAt: number }
  | { type: 'transition-notify'; key: string; leaseId: string; expiresAt: number; phase: 'claimed' | 'dispatching'; attemptN?: number; routeKind?: WakeRouteKind }
  | { type: 'release-notify'; key: string; leaseId: string }
  | { type: 'consume'; name: string; throughIndex: number; at: number }
  | { type: 'compact'; keep: number; archivePath: string }
  | { type: 'repair'; doc: SquareDoc; quarantine?: { path: string; blocks: string[] } };

export interface Committed<Result> {
  result: Result;
  acts: StoredAct[];
}

/** The only persistence primitive: one per-square lock, one Markdown write, one sidecar write. */
export async function withSquareLock<T>(squarePath: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(
    `${squarePath}.lock`,
    { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS },
    fn,
  );
}

export function writeSquareDoc(squarePath: string, doc: SquareDoc): void {
  const temporary = path.join(path.dirname(squarePath), `.${path.basename(squarePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, renderSquareDoc(doc));
  fs.renameSync(temporary, squarePath);
  saveRuntimeSidecar(squarePath, doc.runtime);
}

export function appendAct(squarePath: string, doc: SquareDoc, act: Act): StoredAct {
  const stored = applyActs(doc, [act])[0];
  writeSquareDoc(squarePath, doc);
  return stored;
}

function applyActs(doc: SquareDoc, acts: Act[], mutateRuntime?: (doc: SquareDoc) => void): StoredAct[] {
  const stored: StoredAct[] = [];
  for (const act of acts) {
    const item = { ...act, index: doc.runtime.nextActIndex } as StoredAct;
    doc.runtime.nextActIndex++;
    doc.acts.push(item);
    if (item.actor !== undefined) touchPresenceCursor(doc, item.actor, item.at, item.index);
    stored.push(item);
  }
  mutateRuntime?.(doc);
  return stored;
}

/**
 * Publish a dependent persistence file before the Square document. A retained
 * backup lets a failed document commit restore the prior file exactly.
 */
function prepareAppend(filePath: string, block: string, existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''): StagedReplacement {
  return stageReplacement(filePath, (stage) => {
    fs.writeFileSync(stage, `${existing}${existing === '' ? '' : '\n'}${block}\n`);
  });
}

function plan(doc: SquareDoc, intent: Intent): CommitPlan<unknown> {
  switch (intent.type) {
    case 'join': {
      const decision = decideJoin(doc, intent.name, intent.now);
      return { result: decision, acts: [decision.joinAct] };
    }
    case 'say': {
      const decision = decideAct(doc, intent);
      return {
        result: decision,
        acts: decision.type === 'sent' ? [decision.act] : [],
      };
    }
    case 'hold':
      return { result: undefined, acts: [coreHold(doc, intent.actor, intent.body, intent.now)] };
    case 'resume':
      return { result: undefined, acts: [coreResume(doc, intent.actor, intent.now)] };
    case 'done':
      return { result: undefined, acts: [coreDone(doc, intent.name, intent.body, intent.now)] };
    case 'lease': {
      const name = resolveKnownName(doc, intent.name);
      const existing = freshWatchLease(doc, name, intent.at);
      if (existing !== undefined && !intent.force) {
        return { result: { type: 'active' as const, lease: existing }, acts: [] };
      }
      return {
        result: { type: 'started' as const, name, replaced: existing !== undefined },
        acts: [],
        mutateRuntime: (nextDoc) => {
          writeWatchLease(nextDoc, name, {
            leaseId: intent.leaseId,
            ...(intent.ownerId === undefined ? {} : { ownerId: intent.ownerId }),
            heartbeatAt: intent.at,
            expiresAt: intent.expiresAt,
            ...(intent.filter === undefined ? {} : { filter: intent.filter }),
          });
          touchPresenceCursor(nextDoc, name, intent.at);
        },
      };
    }
    case 'release-lease': {
      const name = resolveKnownName(doc, intent.name);
      if (watchLease(doc, name)?.leaseId !== intent.leaseId) {
        return { result: { released: false }, acts: [] };
      }
      return {
        result: { released: true },
        acts: [],
        mutateRuntime: (nextDoc) => { removeWatchLease(nextDoc, name, intent.leaseId); },
      };
    }
    case 'claim-notify': {
      const current = doc.runtime.notifyLeases[intent.key];
      if (current !== undefined && current.expiresAt > intent.at) return { result: { type: 'busy' as const }, acts: [] };
      if (current?.phase === 'dispatching') return { result: { type: 'ambiguous' as const, lease: current }, acts: [] };
      return {
        result: { type: 'acquired' as const, leaseId: intent.leaseId },
        acts: [],
        mutateRuntime: (nextDoc) => {
          nextDoc.runtime.notifyLeases[intent.key] = {
            leaseId: intent.leaseId,
            expiresAt: intent.expiresAt,
            phase: 'claimed',
          };
        },
      };
    }
    case 'transition-notify': {
      if (doc.runtime.notifyLeases[intent.key]?.leaseId !== intent.leaseId) return { result: { updated: false }, acts: [] };
      return {
        result: { updated: true },
        acts: [],
        mutateRuntime: (nextDoc) => {
          nextDoc.runtime.notifyLeases[intent.key] = {
            leaseId: intent.leaseId,
            expiresAt: intent.expiresAt,
            phase: intent.phase,
            ...(intent.attemptN === undefined ? {} : { attemptN: intent.attemptN }),
            ...(intent.routeKind === undefined ? {} : { routeKind: intent.routeKind }),
          };
        },
      };
    }
    case 'release-notify': {
      if (doc.runtime.notifyLeases[intent.key]?.leaseId !== intent.leaseId) return { result: { released: false }, acts: [] };
      return {
        result: { released: true },
        acts: [],
        mutateRuntime: (nextDoc) => { delete nextDoc.runtime.notifyLeases[intent.key]; },
      };
    }
    case 'consume': {
      const name = resolveKnownName(doc, intent.name);
      return {
        result: { name },
        acts: [],
        mutateRuntime: (nextDoc) => { advanceCursor(nextDoc, name, intent.throughIndex, intent.at); },
      };
    }
    case 'compact': {
      const result = coreCompact(doc, intent.keep);
      const archive = result.archived;
      return {
        result,
        acts: [],
        replaceDoc: result.doc,
        preparePersistence: archive.length === 0
          ? undefined
          : () => {
              const existing = fs.existsSync(intent.archivePath) ? fs.readFileSync(intent.archivePath, 'utf8') : '';
              const block = archive
                .map((act, index) => renderArtifactAct(act, { first: existing === '' && index === 0 }))
                .join('\n');
              return prepareAppend(intent.archivePath, block, existing);
            },
      };
    }
    case 'repair':
      return {
        result: undefined,
        acts: [],
        replaceDoc: intent.doc,
        preparePersistence: intent.quarantine === undefined || intent.quarantine.blocks.length === 0
          ? undefined
          : () => {
              const block = intent.quarantine!.blocks.join('\n\n');
              return prepareAppend(intent.quarantine!.path, block);
            },
      };
  }
}

function commitPlan<Result>(squarePath: string, doc: SquareDoc, planned: CommitPlan<Result>): Committed<Result> {
  const nextDoc = planned.replaceDoc ?? doc;
  const committed = { result: planned.result, acts: applyActs(nextDoc, planned.acts, planned.mutateRuntime) };
  if (planned.acts.length === 0 && planned.mutateRuntime === undefined && planned.replaceDoc === undefined) {
    return committed;
  }
  let persistence: StagedReplacement | undefined;
  try {
    persistence = planned.preparePersistence?.();
    writeSquareDoc(squarePath, nextDoc);
    persistence?.finalize();
    return committed;
  } catch (error) {
    try { persistence?.rollback(); } catch {}
    throw error;
  }
}

/** The one mutation pipeline shared by package and CLI adapters. */
export async function execute<Result = unknown>(squarePath: string, intent: Intent): Promise<Committed<Result>> {
  return withSquareLock(squarePath, () => {
    const doc = loadSquare(squarePath);
    return commitPlan(squarePath, doc, plan(doc, intent) as CommitPlan<Result>);
  });
}

/** Application-owned artifact creation; adapters provide validated options and stdin text only. */
export async function createSquare(
  squarePath: string,
  options: BuildOptions & { hardCap: HardCap },
  snippet: string
): Promise<void> {
  await withSquareLock(squarePath, () => {
    if (fs.existsSync(squarePath) && !options.force) {
      throw new SquareError('conflict', `Refusing to overwrite existing square: ${squarePath}\nPass -f to overwrite.`);
    }
    const temporary = path.join(path.dirname(squarePath), `.${path.basename(squarePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.mkdirSync(path.dirname(squarePath), { recursive: true });
    fs.writeFileSync(temporary, renderSquare(options, snippet));
    fs.renameSync(temporary, squarePath);
    saveRuntimeSidecar(squarePath, emptyRuntimeState(0));
  });
}

/** Keep artifact repair planning and dependent quarantine persistence inside the application boundary. */
export async function repairSquare(squarePath: string): Promise<PlanRepairResult> {
  const result = await withSquareLock(squarePath, () => {
    let text: string;
    try { text = fs.readFileSync(squarePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SquareError('not_found', `square file not found: ${squarePath}`);
      throw error;
    }
    const repair = planRepair(text);
    if (repair.diagnosis.unfixable || repair.repaired === undefined) return { repair };
    // Repair changes Markdown only. Keep the sidecar's runtime metadata and
    // merge history boundaries so a doctor run cannot erase delivery state or
    // reuse a stable activity index.
    const sidecarRuntime = loadRuntimeSidecar(squarePath, repair.repaired.doc.runtime);
    const indexesPreserved = repair.diagnosis.acts.every(
      ({ act }, index) => repair.repaired!.doc.acts[index]?.index === act.index,
    );
    if (indexesPreserved) {
      repair.repaired.doc.runtime = mergeRuntimeState(repair.repaired.doc.runtime, sidecarRuntime);
    } else {
      repair.repaired.doc.runtime = emptyRuntimeState(
        Math.max(repair.repaired.doc.runtime.nextActIndex, sidecarRuntime.nextActIndex),
      );
      repair.repaired.actions.push({ message: 'reset runtime delivery metadata because act indexes changed' });
    }
    const quarantinePath = squarePath.replace(/\.md$/, '') + '.quarantine.md';
    const intent: Intent = {
      type: 'repair',
      doc: repair.repaired.doc,
      ...(repair.repaired.quarantinedBlocks.length === 0
        ? {}
        : { quarantine: { path: quarantinePath, blocks: repair.repaired.quarantinedBlocks } }),
    };
    commitPlan(squarePath, repair.repaired.doc, plan(repair.repaired.doc, intent));
    return { repair };
  });
  return result.repair;
}
