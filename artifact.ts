import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import zlib from 'node:zlib';

import {
  isWakeRouteKind,
  nameKey,
  SquareError,
  type BuildOptions,
  type DeliveryReceipt,
  type HardCap,
  type NotifyLease,
  type ReadCursor,
  type SquareDoc,
  type SquareRuntimeState,
  type StoredAct,
  type WatchLease,
} from './model.js';

const SQUARE_MAGIC = Buffer.from('SQUARE01', 'ascii');
const ARCHIVE_MAGIC = Buffer.from('SQARCH01', 'ascii');
const LENGTH_BYTES = 4;
const DIGEST_BYTES = 32;
const HEADER_BYTES = SQUARE_MAGIC.length + LENGTH_BYTES + DIGEST_BYTES;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface DoctorProblem {
  kind: string;
  message: string;
}

export interface DiagnoseResult {
  unfixable?: string;
  problems: DoctorProblem[];
  doc?: SquareDoc;
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

function validateReadCursor(value: unknown): value is ReadCursor {
  return isObject(value)
    && hasExactKeys(value, ['consumedThroughIndex', 'updatedAt'])
    && Number.isSafeInteger(value.consumedThroughIndex)
    && (value.consumedThroughIndex as number) >= -1
    && isFiniteNumber(value.updatedAt);
}

function validateDeliveryReceipt(value: unknown): value is DeliveryReceipt {
  return isObject(value)
    && hasExactKeys(value, ['status', 'at'])
    && value.status === 'delivered'
    && isFiniteNumber(value.at);
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

function validateNotifyLease(value: unknown): value is NotifyLease {
  if (!isObject(value)
    || !hasExactKeys(value, ['leaseId', 'expiresAt', 'phase'], ['attemptN', 'routeKind'])
    || !isNonblankString(value.leaseId)
    || !isFiniteNumber(value.expiresAt)
    || (value.phase !== 'claimed' && value.phase !== 'dispatching')
    || (value.attemptN !== undefined && (!Number.isSafeInteger(value.attemptN) || (value.attemptN as number) <= 0))
    || (value.routeKind !== undefined && !isWakeRouteKind(value.routeKind))) return false;
  return value.phase !== 'dispatching' || (value.attemptN !== undefined && value.routeKind !== undefined);
}

function validateRecord(value: unknown, item: (candidate: unknown) => boolean): value is Record<string, unknown> {
  return isObject(value)
    && Object.entries(value).every(([key, candidate]) => key.length > 0 && item(candidate));
}

function parseActIndexId(id: string): number | undefined {
  const match = /^act_(\d+)$/.exec(id);
  if (!match) return undefined;
  const digits = match[1];
  if (digits.length > 1 && digits.startsWith('0')) return undefined;
  const index = Number(digits);
  return Number.isSafeInteger(index) ? index : undefined;
}

function parseNotifyLeaseKey(key: string): { index: number; name: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
  const [id, name] = parsed;
  if (typeof id !== 'string' || typeof name !== 'string' || name.length === 0 || nameKey(name) !== name) {
    return undefined;
  }
  const index = parseActIndexId(id);
  if (index === undefined) return undefined;
  if (JSON.stringify([id, name]) !== key) return undefined;
  return { index, name };
}

function validateRuntime(value: unknown): value is SquareRuntimeState {
  if (!isObject(value)
    || !hasExactKeys(value, ['nextActIndex', 'cursors', 'deliveryReceipts', 'leases', 'notifyLeases'])
    || !isNonNegativeInteger(value.nextActIndex)
    || !validateRecord(value.cursors, validateReadCursor)
    || !validateRecord(value.leases, validateWatchLease)
    || !validateRecord(value.notifyLeases, validateNotifyLease)
    || !isObject(value.deliveryReceipts)) return false;
  return Object.entries(value.deliveryReceipts).every(([name, receipts]) =>
    name.length > 0
      && isObject(receipts)
      && Object.entries(receipts).every(([id, receipt]) => parseActIndexId(id) !== undefined && validateDeliveryReceipt(receipt))
  );
}

function validateAssignedRuntimeReferences(runtime: SquareRuntimeState): 'ok' | 'malformed' | 'future' {
  const bound = runtime.nextActIndex;
  for (const cursor of Object.values(runtime.cursors)) {
    if (cursor.consumedThroughIndex !== -1 && cursor.consumedThroughIndex >= bound) return 'future';
  }
  for (const receipts of Object.values(runtime.deliveryReceipts)) {
    for (const id of Object.keys(receipts)) {
      const index = parseActIndexId(id);
      if (index === undefined) return 'malformed';
      if (index >= bound) return 'future';
    }
  }
  for (const key of Object.keys(runtime.notifyLeases)) {
    const parsed = parseNotifyLeaseKey(key);
    if (parsed === undefined) return 'malformed';
    if (parsed.index >= bound) return 'future';
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

function validateSquareDoc(value: unknown): SquareDoc {
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
  return value as unknown as SquareDoc;
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
    cursors: {},
    deliveryReceipts: {},
    leases: {},
    notifyLeases: {},
  };
}

function normalizedLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  return normalized === '' ? [] : normalized.split('\n');
}

function readGuide(name: string): string {
  try {
    return fs.readFileSync(new URL(`../guides/${name}.md`, import.meta.url), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SquareError('invalid_args', `Unknown square guide: ${name}`);
    }
    throw error;
  }
}

export function createSquareDoc(
  options: BuildOptions & { hardCap: HardCap },
  snippet: string,
): SquareDoc {
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

export function encodeSquare(doc: SquareDoc): Buffer {
  return encodeEnvelope(SQUARE_MAGIC, validateSquareDoc(doc));
}

export function decodeSquare(bytes: Buffer): SquareDoc {
  return validateSquareDoc(decodeEnvelope(bytes, SQUARE_MAGIC));
}

export function encodeArchive(acts: StoredAct[]): Buffer {
  if (!validateActs(acts)) throw invalidArtifact('archive activity schema is malformed.');
  return encodeEnvelope(ARCHIVE_MAGIC, { acts });
}

export function decodeArchive(bytes: Buffer): StoredAct[] {
  const value = decodeEnvelope(bytes, ARCHIVE_MAGIC);
  if (!isObject(value) || !hasExactKeys(value, ['acts']) || !validateActs(value.acts)) {
    throw invalidArtifact('archive schema is malformed.');
  }
  return value.acts;
}

function readArtifact(squarePath: string): Buffer {
  try {
    return fs.readFileSync(squarePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SquareError('not_found', `square file not found: ${squarePath}`);
    }
    throw error;
  }
}

function requireSquareExtension(squarePath: string): void {
  if (!squarePath.endsWith('.square')) {
    throw new SquareError('invalid_args', `Square artifacts must use the .square extension: ${squarePath}`);
  }
}

function atomicWrite(target: string, bytes: Buffer): void {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function writeSquareFile(squarePath: string, doc: SquareDoc): void {
  requireSquareExtension(squarePath);
  atomicWrite(squarePath, encodeSquare(doc));
}

export function loadSquare(squarePath: string): SquareDoc {
  requireSquareExtension(squarePath);
  return decodeSquare(readArtifact(squarePath));
}

export function writeArchiveFile(archivePath: string, acts: StoredAct[]): void {
  atomicWrite(archivePath, encodeArchive(acts));
}

export function loadArchive(archivePath: string): StoredAct[] {
  return decodeArchive(readArtifact(archivePath));
}

export function probeSquare(squarePath: string): SquareDoc | undefined {
  if (!squarePath.endsWith('.square')) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(squarePath, 'r');
    const magic = Buffer.alloc(SQUARE_MAGIC.length);
    if (fs.readSync(descriptor, magic, 0, magic.length, 0) !== magic.length || !magic.equals(SQUARE_MAGIC)) {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    return loadSquare(squarePath);
  } catch {
    return undefined;
  }
}

export function diagnoseSquareFile(squarePath: string): DiagnoseResult {
  try {
    return { problems: [], doc: loadSquare(squarePath) };
  } catch (error) {
    return {
      unfixable: error instanceof Error ? error.message : String(error),
      problems: [],
    };
  }
}
