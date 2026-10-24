import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ActivityId } from '@astrosheep/square';

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

export interface SlackMessagePointer {
  readonly ts: string;
  readonly threadTs: string;
}

/**
 * The bridge's own memory: the last mirrored activity, the Slack names it has
 * assigned, and the two-way message map. Only state lives here; identities are
 * derived from it by the directory.
 */
export interface BridgeState {
  version: 1;
  cursor: string | null;
  users: Record<string, string>;
  tsToActivity: Record<string, string>;
  activityToTs: Record<string, SlackMessagePointer>;
}

export interface LoadedState {
  readonly state: BridgeState;
  /** No state file existed yet, so this run decides where the cursor begins. */
  readonly fresh: boolean;
}

const MAX_ENTRIES = 5000;
const ACTIVITY_ID = /^act\/(?:0|[1-9]\d*)$/;

/** A stored activity id, when it still has Square's shape. */
export function asActivityId(value: string | null | undefined): ActivityId | undefined {
  return value !== null && value !== undefined && ACTIVITY_ID.test(value) ? value as ActivityId : undefined;
}

export function emptyState(): BridgeState {
  return { version: 1, cursor: null, users: {}, tsToActivity: {}, activityToTs: {} };
}

export async function loadState(file: string): Promise<LoadedState> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState(), fresh: true };
    throw new StateError(`cannot read state file ${file}: ${describe(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  }
  catch {
    throw new StateError(`state file ${file} is not valid JSON`);
  }
  return { state: parse(file, parsed), fresh: false };
}

export interface StateStore {
  readonly state: BridgeState;
  /** Serialized atomic writes: a later save never loses an earlier mutation. */
  save(): Promise<void>;
}

export function createStateStore(file: string, state: BridgeState): StateStore {
  let pending: Promise<void> = Promise.resolve();
  return {
    state,
    save() {
      const run = pending.then(() => saveState(file, state));
      pending = run.catch(() => undefined);
      return run;
    },
  };
}

export async function saveState(file: string, state: BridgeState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, file);
}

/** Record one mirrored message in both directions; a thread root is its own ts. */
export function rememberMessage(state: BridgeState, activity: ActivityId, ts: string, threadTs?: string): void {
  const pointer = { ts, threadTs: threadTs ?? ts };
  remember(state.tsToActivity, ts, activity);
  remember(state.activityToTs, activity, pointer);
}

function remember<T>(map: Record<string, T>, key: string, value: T): void {
  map[key] = value;
  const keys = Object.keys(map);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[stale];
}

function parse(file: string, parsed: unknown): BridgeState {
  const corrupt = (detail: string): never => {
    throw new StateError(`state file ${file} is corrupt: ${detail}`);
  };
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return corrupt('expected a JSON object');
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return corrupt(`unsupported version ${JSON.stringify(record.version)}`);
  if (record.cursor !== null && asActivityId(record.cursor as string) === undefined) return corrupt('cursor must be an activity id or null');
  return {
    version: 1,
    cursor: record.cursor as string | null,
    users: stringMap(record.users) ?? corrupt('users must map Slack user IDs to names'),
    tsToActivity: stringMap(record.tsToActivity) ?? corrupt('tsToActivity must map message timestamps to activity ids'),
    activityToTs: pointers(record.activityToTs) ?? corrupt('activityToTs must map activity ids to message pointers'),
  };
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => typeof entry !== 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function pointers(value: unknown): Record<string, SlackMessagePointer> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, SlackMessagePointer> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const { ts, threadTs } = entry as Record<string, unknown>;
    if (typeof ts !== 'string' || typeof threadTs !== 'string') return undefined;
    result[key] = { ts, threadTs };
  }
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
