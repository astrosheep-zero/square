import fs from 'node:fs';

import {
  isWakeRouteKind,
  SquareError,
  type ActivityObservation,
  type BuildOptions,
  type HardCap,
  type SquareRuntimeState,
  type SquareState,
  type StoredAct,
  type WatchLease,
} from './model.js';
import { parseActivityId } from './square-core.js';

const guideNames = ['participant', 'architect', 'brainstorm'];
const guideContents = new Map<string, string>(await Promise.all(
  guideNames.map(async (name) => [name, (await fs.promises.readFile(new URL(`../guides/${name}.md`, import.meta.url), 'utf8')).trim()] as const),
));

function invalidArtifact(detail: string): SquareError {
  return new SquareError('invalid_args', `Invalid square artifact: ${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
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
  return isObject(value) && hasExactKeys(value, ['state', 'at']) && value.state === 'seen' && isFiniteNumber(value.at);
}

function validateWatchLease(value: unknown): value is WatchLease {
  if (!isObject(value) || !hasExactKeys(value, ['leaseId', 'heartbeatAt', 'expiresAt'], ['filter'])
    || !isNonblankString(value.leaseId) || !isFiniteNumber(value.heartbeatAt)
    || !isFiniteNumber(value.expiresAt) || value.expiresAt < value.heartbeatAt) return false;
  if (value.filter === undefined) return true;
  return isObject(value.filter) && hasExactKeys(value.filter, [], ['participants', 'mention'])
    && (value.filter.participants === undefined || isStringArray(value.filter.participants))
    && (value.filter.mention === undefined || typeof value.filter.mention === 'string');
}

function validateRecord(value: unknown, item: (candidate: unknown) => boolean): value is Record<string, unknown> {
  return isObject(value) && Object.entries(value).every(([key, candidate]) => key.length > 0 && item(candidate));
}

function validateRuntime(value: unknown): value is SquareRuntimeState {
  return isObject(value) && hasExactKeys(value, ['nextActIndex', 'observations', 'leases'])
    && isNonNegativeInteger(value.nextActIndex)
    && validateRecord(value.observations, (candidate) => isObject(candidate)
      && Object.entries(candidate).every(([id, observation]) => parseActivityId(id) !== undefined && validateObservation(observation)))
    && validateRecord(value.leases, validateWatchLease);
}

function validateAssignedRuntimeReferences(runtime: SquareRuntimeState): 'ok' | 'malformed' | 'future' {
  for (const observations of Object.values(runtime.observations)) {
    for (const id of Object.keys(observations)) {
      const index = parseActivityId(id);
      if (index === undefined) return 'malformed';
      if (index >= runtime.nextActIndex) return 'future';
    }
  }
  return 'ok';
}

function validateActor(value: unknown, required: boolean): boolean {
  return required ? isNonblankString(value) : value === undefined || isNonblankString(value);
}

function validateStoredAct(value: unknown): value is StoredAct {
  if (!isObject(value) || typeof value.kind !== 'string' || !isNonNegativeInteger(value.index) || !isFiniteNumber(value.at)) return false;
  switch (value.kind) {
    case 'join': return hasExactKeys(value, ['kind', 'actor', 'at', 'index']) && validateActor(value.actor, true);
    case 'done': return hasExactKeys(value, ['kind', 'actor', 'at', 'index'], ['body']) && validateActor(value.actor, true) && (value.body === undefined || typeof value.body === 'string');
    case 'say': return hasExactKeys(value, ['kind', 'actor', 'at', 'body', 'index'], ['mentions', 'reach', 'reply'])
      && validateActor(value.actor, true) && typeof value.body === 'string'
      && (value.mentions === undefined || isStringArray(value.mentions)) && (value.reach === undefined || value.reach === 'bell')
      && (value.reply === undefined || isNonNegativeInteger(value.reply));
    case 'hold': return hasExactKeys(value, ['kind', 'at', 'index'], ['actor', 'body']) && validateActor(value.actor, false) && (value.body === undefined || typeof value.body === 'string');
    case 'resume': return hasExactKeys(value, ['kind', 'at', 'index'], ['actor']) && validateActor(value.actor, false);
    case 'read': return hasExactKeys(value, ['kind', 'actor', 'at', 'through', 'index']) && validateActor(value.actor, true) && isNonNegativeInteger(value.through);
    case 'listen':
    case 'ignore': return hasExactKeys(value, ['kind', 'actor', 'target', 'at', 'index']) && validateActor(value.actor, true) && validateActor(value.target, true);
    default: return false;
  }
}

function validateActs(value: unknown): value is StoredAct[] {
  if (!Array.isArray(value) || !value.every(validateStoredAct)) return false;
  let previous = -1;
  for (const act of value) {
    if (act.index <= previous || (act.kind === 'say' && act.reply !== undefined && act.reply >= act.index)) return false;
    previous = act.index;
  }
  return true;
}

export function validateSquareState(value: unknown): SquareState {
  if (!isObject(value) || !hasExactKeys(value, ['hardCap', 'preamble', 'warmup', 'acts', 'runtime'], ['throttlePerMinute', 'routes'])
    || !(value.hardCap === null || (Number.isSafeInteger(value.hardCap) && (value.hardCap as number) > 0))
    || (value.throttlePerMinute !== undefined && (!Number.isSafeInteger(value.throttlePerMinute) || (value.throttlePerMinute as number) <= 0))
    || !isStringArray(value.preamble) || !isStringArray(value.warmup) || !validateActs(value.acts)
    || (value.routes !== undefined && (!Array.isArray(value.routes) || !value.routes.every((route) => isObject(route) && isWakeRouteKind(route.kind)
      && typeof route.location === 'string' && typeof route.participant === 'string' && typeof route.sessionId === 'string'
      && typeof route.channel === 'string' && isObject(route.address) && Object.values(route.address).every((item) => typeof item === 'string')
      && typeof route.updatedAt === 'number')))
    || !validateRuntime(value.runtime)) throw invalidArtifact('snapshot schema is malformed.');
  const historyBoundary = value.acts.at(-1)?.index ?? -1;
  if (value.runtime.nextActIndex <= historyBoundary) throw invalidArtifact('nextActIndex is behind the activity history.');
  const references = validateAssignedRuntimeReferences(value.runtime as SquareRuntimeState);
  if (references === 'malformed') throw invalidArtifact('snapshot schema is malformed.');
  if (references === 'future') throw invalidArtifact('runtime references an unassigned activity index.');
  return value as unknown as SquareState;
}

export function emptyRuntimeState(nextActIndex = 0): SquareRuntimeState {
  return { nextActIndex, observations: {}, leases: {} };
}

function normalizedLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  return normalized === '' ? [] : normalized.split('\n');
}

function readGuide(name: string): string {
  const guide = guideContents.get(name);
  if (guide === undefined) throw new SquareError('invalid_args', `Unknown square guide: ${name}`);
  return guide;
}

export function createSquareState(options: BuildOptions & { hardCap: HardCap }, snippet: string): SquareState {
  const guides = [readGuide('participant')];
  if (options.template !== undefined) guides.push(readGuide(options.template));
  return {
    hardCap: options.hardCap,
    ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
    preamble: normalizedLines(snippet),
    warmup: normalizedLines(guides.join('\n\n')),
    acts: [], routes: [], runtime: emptyRuntimeState(),
  };
}
