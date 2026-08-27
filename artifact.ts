import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import zlib from 'node:zlib';

import {
  isWakeRouteKind,
  InternalSquareError,
  nameKey,
  SquareError,
  type BuildOptions,
  type ActivityObservation,
  type HardCap,
  type SquareState,
  type SquareRuntimeState,
  type StoredAct,
  type WatchLease,
} from './model.js';
import { parseActivityId } from './square-core.js';

const SQUARE_MAGIC = Buffer.from('SQUARE01', 'ascii');
const LENGTH_BYTES = 4;
const DIGEST_BYTES = 32;
const HEADER_BYTES = SQUARE_MAGIC.length + LENGTH_BYTES + DIGEST_BYTES;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const guideNames = ['participant', 'architect', 'brainstorm'];
const guideContents = new Map<string, string>(await Promise.all(
  guideNames.map(async (name) => [name, (await fs.promises.readFile(new URL(`../guides/${name}.md`, import.meta.url), 'utf8')).trim()] as const),
));

export interface DoctorProblem {
  kind: string;
  message: string;
}

export interface DiagnoseResult {
  unfixable?: string;
  problems: DoctorProblem[];
  state?: SquareState;
}

function invalidArtifact(detail: string): SquareError {
  return new SquareError('invalid_args', `Invalid square artifact: ${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateObservation(value: unknown): value is ActivityObservation {
  return isObject(value)
    && hasExactKeys(value, ['state', 'at'], ['ownerId'])
    && value.state === 'seen'
    && isFiniteNumber(value.at)
    && (value.ownerId === undefined || isNonblankString(value.ownerId));
}

function validateWatchLease(value: unknown): value is WatchLease {
  if (!isObject(value)
    || !hasExactKeys(value, ['leaseId', 'heartbeatAt', 'expiresAt'], ['ownerId', 'filter'])
    || !isNonblankString(value.leaseId)
    || (value.ownerId !== undefined && !isNonblankString(value.ownerId))
    || !isFiniteNumber(value.heartbeatAt)
    || !isFiniteNumber(value.expiresAt)
    || value.expiresAt < value.heartbeatAt) return false;
  if (value.filter === undefined) return true;
  return isObject(value.filter)
    && hasExactKeys(value.filter, [], ['participants', 'mention'])
    && (value.filter.participants === undefined || isStringArray(value.filter.participants))
    && (value.filter.mention === undefined || typeof value.filter.mention === 'string');
}

function validateRecord(value: unknown, item: (candidate: unknown) => boolean): value is Record<string, unknown> {
  return isObject(value)
    && Object.entries(value).every(([key, candidate]) => key.length > 0 && item(candidate));
}

function validateRuntime(value: unknown): value is SquareRuntimeState {
  if (!isObject(value)
    || !hasExactKeys(value, ['nextActIndex', 'observations', 'leases'])
    || !isNonNegativeInteger(value.nextActIndex)
    || !validateRecord(value.observations, (candidate) => isObject(candidate) && Object.entries(candidate).every(([id, observation]) => parseActivityId(id) !== undefined && validateObservation(observation)))
    || !validateRecord(value.leases, validateWatchLease)
    ) return false;
  return true;
}

function validateAssignedRuntimeReferences(runtime: SquareRuntimeState): 'ok' | 'malformed' | 'future' {
  const bound = runtime.nextActIndex;
  for (const observations of Object.values(runtime.observations)) {
    for (const id of Object.keys(observations)) {
      const index = parseActivityId(id);
      if (index === undefined) return 'malformed';
      if (index >= bound) return 'future';
    }
  }
  return 'ok';
}

function validateActor(value: unknown, required: boolean): boolean {
  return required ? isNonblankString(value) : value === undefined || isNonblankString(value);
}

function validateStoredAct(value: unknown): value is StoredAct {
  if (!isObject(value)
    || typeof value.kind !== 'string'
    || !isNonNegativeInteger(value.index)
    || !isFiniteNumber(value.at)) return false;

  switch (value.kind) {
    case 'join':
      return hasExactKeys(value, ['kind', 'actor', 'at', 'index']) && validateActor(value.actor, true);
    case 'done':
      return hasExactKeys(value, ['kind', 'actor', 'at', 'index'], ['body'])
        && validateActor(value.actor, true)
        && (value.body === undefined || typeof value.body === 'string');
    case 'say':
      return hasExactKeys(value, ['kind', 'actor', 'at', 'body', 'index'], ['reach', 'reply'])
        && validateActor(value.actor, true)
        && typeof value.body === 'string'
        && (value.reach === undefined || value.reach === 'bell')
        && (value.reply === undefined || isNonNegativeInteger(value.reply));
    case 'hold':
      return hasExactKeys(value, ['kind', 'at', 'index'], ['actor', 'body'])
        && validateActor(value.actor, false)
        && (value.body === undefined || typeof value.body === 'string');
    case 'resume':
      return hasExactKeys(value, ['kind', 'at', 'index'], ['actor']) && validateActor(value.actor, false);
    case 'read':
      return hasExactKeys(value, ['kind', 'actor', 'at', 'through', 'index'])
        && validateActor(value.actor, true)
        && isNonNegativeInteger(value.through);
    case 'listen':
    case 'ignore':
      return hasExactKeys(value, ['kind', 'actor', 'target', 'at', 'index'])
        && validateActor(value.actor, true)
        && validateActor(value.target, true);
    default:
      return false;
  }
}

function validateActs(value: unknown): value is StoredAct[] {
  if (!Array.isArray(value) || !value.every(validateStoredAct)) return false;
  let previous = -1;
  for (const act of value) {
    if (act.index <= previous) return false;
    if (act.kind === 'say' && act.reply !== undefined && act.reply >= act.index) return false;
    previous = act.index;
  }
  return true;
}

function validateSquareState(value: unknown): SquareState {
  if (!isObject(value)
    || !hasExactKeys(value, ['hardCap', 'preamble', 'warmup', 'acts', 'runtime'], ['throttlePerMinute'])
    || !(value.hardCap === null || (Number.isSafeInteger(value.hardCap) && (value.hardCap as number) > 0))
    || (value.throttlePerMinute !== undefined
      && (!Number.isSafeInteger(value.throttlePerMinute) || (value.throttlePerMinute as number) <= 0))
    || !isStringArray(value.preamble)
    || !isStringArray(value.warmup)
    || !validateActs(value.acts)
    || !validateRuntime(value.runtime)) {
    throw invalidArtifact('snapshot schema is malformed.');
  }
  const acts = value.acts as StoredAct[];
  const runtime = value.runtime as SquareRuntimeState;
  const historyBoundary = acts.at(-1)?.index ?? -1;
  if (runtime.nextActIndex <= historyBoundary) {
    throw invalidArtifact('nextActIndex is behind the activity history.');
  }
  const references = validateAssignedRuntimeReferences(runtime);
  if (references === 'malformed') throw invalidArtifact('snapshot schema is malformed.');
  if (references === 'future') throw invalidArtifact('runtime references an unassigned activity index.');
  return value as unknown as SquareState;
}

function encodeEnvelope(magic: Buffer, value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const payload = zlib.gzipSync(json, { level: 9 });
  if (payload.length > 0xffff_ffff) throw invalidArtifact('compressed payload is too large.');
  const header = Buffer.alloc(HEADER_BYTES);
  magic.copy(header, 0);
  header.writeUInt32BE(payload.length, magic.length);
  crypto.createHash('sha256').update(payload).digest().copy(header, magic.length + LENGTH_BYTES);
  return Buffer.concat([header, payload]);
}

function decodeEnvelope(bytes: Buffer, magic: Buffer): unknown {
  if (bytes.length < HEADER_BYTES) throw invalidArtifact('truncated header.');
  if (!bytes.subarray(0, magic.length).equals(magic)) throw invalidArtifact('bad magic or unsupported format version.');
  const length = bytes.readUInt32BE(magic.length);
  if (bytes.length !== HEADER_BYTES + length) throw invalidArtifact('payload length does not match the file.');
  const expected = bytes.subarray(magic.length + LENGTH_BYTES, HEADER_BYTES);
  const payload = bytes.subarray(HEADER_BYTES);
  const actual = crypto.createHash('sha256').update(payload).digest();
  if (!crypto.timingSafeEqual(expected, actual)) throw invalidArtifact('payload digest mismatch.');

  let inflated: Buffer;
  try {
    inflated = zlib.gunzipSync(payload);
  } catch {
    throw invalidArtifact('payload is not valid gzip data.');
  }
  let text: string;
  try {
    text = utf8.decode(inflated);
  } catch {
    throw invalidArtifact('payload is not valid UTF-8.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidArtifact('payload is not valid JSON.');
  }
}

export function emptyRuntimeState(nextActIndex = 0): SquareRuntimeState {
  return {
    nextActIndex,
    observations: {},
    leases: {},
  };
}

function normalizedLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  return normalized === '' ? [] : normalized.split('\n');
}

function readGuide(name: string): string {
  try {
    const guide = guideContents.get(name);
    if (guide === undefined) throw Object.assign(new Error('missing guide'), { code: 'ENOENT' });
    return guide;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SquareError('invalid_args', `Unknown square guide: ${name}`);
    }
    throw error;
  }
}

export function createSquareState(
  options: BuildOptions & { hardCap: HardCap },
  snippet: string,
): SquareState {
  const guides = [readGuide('participant')];
  if (options.template !== undefined) guides.push(readGuide(options.template));
  return {
    hardCap: options.hardCap,
    ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
    preamble: normalizedLines(snippet),
    warmup: normalizedLines(guides.join('\n\n')),
    acts: [],
    runtime: emptyRuntimeState(),
  };
}

export function encodeSquare(squareState: SquareState): Buffer {
  return encodeEnvelope(SQUARE_MAGIC, validateSquareState(squareState));
}

export function decodeSquare(bytes: Buffer): SquareState {
  return validateSquareState(decodeEnvelope(bytes, SQUARE_MAGIC));
}

async function readArtifact(squarePath: string): Promise<Buffer> {
  try {
    return await fs.promises.readFile(squarePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InternalSquareError('not_found', `square file not found: ${squarePath}`);
    }
    throw error;
  }
}

function requireSquareExtension(squarePath: string): void {
  if (!squarePath.endsWith('.square')) {
    throw new SquareError('invalid_args', `Square artifacts must use the .square extension: ${squarePath}`);
  }
}

async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.writeFile(temporary, bytes);
    await fs.promises.rename(temporary, target);
  } catch (error) {
    try { await fs.promises.unlink(temporary); } catch {}
    throw error;
  }
}

export async function writeSquareFile(squarePath: string, squareState: SquareState): Promise<void> {
  requireSquareExtension(squarePath);
  await atomicWrite(squarePath, encodeSquare(squareState));
}

export async function loadSquare(squarePath: string): Promise<SquareState> {
  requireSquareExtension(squarePath);
  return decodeSquare(await readArtifact(squarePath));
}

export async function probeSquare(squarePath: string): Promise<SquareState | undefined> {
  if (!squarePath.endsWith('.square')) return undefined;
  let descriptor: fs.promises.FileHandle | undefined;
  try {
    descriptor = await fs.promises.open(squarePath, 'r');
    const magic = Buffer.alloc(SQUARE_MAGIC.length);
    if ((await descriptor.read(magic, 0, magic.length, 0)).bytesRead !== magic.length || !magic.equals(SQUARE_MAGIC)) {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) await descriptor.close();
  }
  try {
    return await loadSquare(squarePath);
  } catch {
    return undefined;
  }
}

export async function diagnoseSquareFile(squarePath: string): Promise<DiagnoseResult> {
  try {
    return { problems: [], state: await loadSquare(squarePath) };
  } catch (error) {
    return {
      unfixable: error instanceof Error ? error.message : String(error),
      problems: [],
    };
  }
}
