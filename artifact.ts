import fs from 'node:fs';

import {
  ACTIVITIES_HEADING,
  ACTIVITIES_MARKER,
  ACT_MARKER_PREFIX,
  WARMUP_HEADING,
  WARMUP_MARKER,
  type StoredAct,
  type StoredActHead,
  type SquareDoc,
  type Reach,
  type ReadCursor,
  type DeliveryReceipt,
  type NotifyLease,
  type SquareRuntimeState,
  type WatchLease,
  type BuildOptions,
  type HardCap,
  SquareError,
  CURRENT_FORMAT_VERSION,
  formatHardCap,
  sameName,
} from './model.js';
import { formatTimestamp, parseTimestamp } from './time.js';
import { isWakeRouteKind } from './routes.js';

const V2_KINDS = new Set(['say', 'join', 'done', 'hold', 'resume']);

export function quoteBody(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (normalized === '') return '>';
  return normalized
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

export function unquoteBody(lines: string[]): string {
  const out = [...lines];
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out
    .map((line) => {
      if (line === '>') return '';
      if (line.startsWith('> ')) return line.slice(2);
      if (line.startsWith('>')) return line.slice(1);
      return line;
    })
    .join('\n')
    .trim();
}

function actIndex(act: StoredAct): number {
  if (act.index === undefined || !Number.isInteger(act.index) || act.index < 0) {
    throw new SquareError('invalid_args', `Invalid square act: missing stable index for ${act.kind}.`);
  }
  return act.index;
}

function renderActMarker(act: StoredAct): string {
  const marker = {
    index: actIndex(act),
    kind: act.kind,
    actor: act.actor,
    at: act.at,
    ...(act.kind === 'say' && act.reach !== undefined ? { reach: act.reach } : {}),
    ...(act.kind === 'say' && act.reply !== undefined ? { reply: act.reply } : {}),
  };
  return `${ACT_MARKER_PREFIX} ${JSON.stringify(marker)} -->`;
}

function actNeedsBody(act: StoredAct): boolean {
  return act.kind === 'say' || act.kind === 'done' || act.kind === 'hold';
}

export function renderArtifactAct(act: StoredAct, opts: { first?: boolean } = {}): string {
  const head = opts.first ? '' : '\n';
  const out = [`${head}${renderActMarker(act)}`, `### ${act.actor}`, `_${act.kind} · ${formatTimestamp(act.at)}_`];
  if (actNeedsBody(act)) out.push('', quoteBody('body' in act ? act.body ?? '' : ''));
  return out.join('\n');
}

export function emptyRuntimeState(nextActIndex = 0): SquareRuntimeState {
  return {
    version: 2,
    nextActIndex,
    cursors: {},
    deliveryReceipts: {},
    leases: {},
    notifyLeases: {},
  };
}

function renderFrontmatter(doc: { hardCap: HardCap; throttlePerMinute?: number }): string {
  return [
    '---',
    `hard_cap: ${formatHardCap(doc.hardCap)}`,
    ...(doc.throttlePerMinute === undefined ? [] : [`throttle_per_minute: ${doc.throttlePerMinute}`]),
    `format_version: ${CURRENT_FORMAT_VERSION}`,
    '---',
  ].join('\n');
}

export function renderSquare(opts: BuildOptions & { hardCap: HardCap }, snippet: string): string {
  const templateFile = opts.template
    ? new URL(`../templates/${opts.template}.md`, import.meta.url)
    : new URL('../template.md', import.meta.url);
  const template = fs.readFileSync(templateFile, 'utf8');
  const body = template.replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();
  const genericGuide = fs.readFileSync(new URL('../guides/participant.md', import.meta.url), 'utf8').trim();
  let templateGuide = '';
  if (opts.template) {
    try {
      templateGuide = '\n\n' + fs.readFileSync(new URL(`../guides/${opts.template}.md`, import.meta.url), 'utf8').trim();
    } catch {
      // No template-specific guide.
    }
  }
  const training = [
    '---',
    '',
    WARMUP_HEADING,
    WARMUP_MARKER,
    '',
    genericGuide + templateGuide,
    '',
  ].join('\n');
  const normalizedSnippet = snippet.replace(/\r\n/g, '\n').trim();

  return [
    renderFrontmatter({
      hardCap: opts.hardCap,
      throttlePerMinute: opts.throttlePerMinute,
    }),
    '',
    normalizedSnippet,
    '',
    training,
    body,
  ].join('\n');
}

function sidecarPath(squarePath: string): string {
  return `${squarePath}.runtime.json`;
}

function invalidRuntimeSidecar(squarePath: string, detail: string): SquareError {
  return new SquareError('invalid_args', `Invalid square runtime sidecar ${sidecarPath(squarePath)}: ${detail}`);
}

function validateRuntimeSidecar(squarePath: string, value: unknown): SquareRuntimeState {
  if (!isObject(value)) throw invalidRuntimeSidecar(squarePath, 'expected a JSON object.');
  if (value.version !== 2) throw invalidRuntimeSidecar(squarePath, 'unsupported or missing version.');
  if (typeof value.nextActIndex !== 'number' || !Number.isInteger(value.nextActIndex) || value.nextActIndex < 0) {
    throw invalidRuntimeSidecar(squarePath, 'nextActIndex must be a non-negative integer.');
  }
  if (!isObject(value.cursors) || !Object.values(value.cursors).every(isReadCursor)) {
    throw invalidRuntimeSidecar(squarePath, 'cursors contains an invalid read cursor.');
  }
  if (!isObject(value.deliveryReceipts) || !Object.values(value.deliveryReceipts).every(isDeliveryReceiptMap)) {
    throw invalidRuntimeSidecar(squarePath, 'deliveryReceipts contains an invalid receipt map.');
  }
  if (!isObject(value.leases) || !Object.values(value.leases).every(isWatchLease)) {
    throw invalidRuntimeSidecar(squarePath, 'leases contains an invalid watch lease.');
  }
  if (value.notifyLeases !== undefined && (!isObject(value.notifyLeases) || !Object.values(value.notifyLeases).every(isNotifyLease))) {
    throw invalidRuntimeSidecar(squarePath, 'notifyLeases contains an invalid notify lease.');
  }
  return {
    version: 2,
    nextActIndex: value.nextActIndex,
    cursors: value.cursors as Record<string, ReadCursor>,
    deliveryReceipts: value.deliveryReceipts as Record<string, Record<string, DeliveryReceipt>>,
    leases: value.leases as Record<string, WatchLease>,
    notifyLeases: (value.notifyLeases ?? {}) as Record<string, NotifyLease>,
  };
}

export function loadRuntimeSidecar(squarePath: string, fallbackRuntime: SquareRuntimeState): SquareRuntimeState {
  const sp = sidecarPath(squarePath);
  try {
    const raw = fs.readFileSync(sp, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidRuntimeSidecar(squarePath, 'malformed JSON.');
    }
    return validateRuntimeSidecar(squarePath, parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallbackRuntime;
    }
    throw err;
  }
}

export function mergeRuntimeState(markdownRuntime: SquareRuntimeState, sidecarRuntime: SquareRuntimeState): SquareRuntimeState {
  return {
    ...sidecarRuntime,
    nextActIndex: Math.max(markdownRuntime.nextActIndex, sidecarRuntime.nextActIndex),
  };
}

export function saveRuntimeSidecar(squarePath: string, runtime: SquareRuntimeState): void {
  const target = sidecarPath(squarePath);
  const normalized = validateRuntimeSidecar(squarePath, runtime);
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2));
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function renderSquareDoc(doc: SquareDoc): string {
  const warmup = renderWarmupSection(doc.warmup);
  return [
    renderFrontmatter({ hardCap: doc.hardCap, throttlePerMinute: doc.throttlePerMinute }),
    '',
    ...doc.preamble,
    ...(doc.preamble.length > 0 ? [''] : []),
    ...warmup,
    '',
    ACTIVITIES_HEADING,
    ACTIVITIES_MARKER,
    ...(doc.acts.length === 0 ? [] : ['', doc.acts.map((act, index) => renderArtifactAct(act, { first: index === 0 })).join('\n')]),
    '',
  ].join('\n');
}

function renderWarmupSection(warmup: string[]): string[] {
  if (warmup[0]?.trim() === WARMUP_HEADING) return [warmup[0], WARMUP_MARKER, ...warmup.slice(1)];
  return [WARMUP_MARKER, ...warmup];
}

export function parsePreamble(text: string): string[] {
  const lines = text.split('\n');
  const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line === '---');
  if (lines[0] !== '---' || frontmatterEnd < 0) throw new SquareError('invalid_args', 'Invalid square: missing frontmatter.');
  const marker = lines.findIndex((line) => line.trim() === WARMUP_MARKER);
  if (marker < 0) throw new SquareError('invalid_args', 'Invalid square: missing embedded warmup.');
  const warmupStart = marker > 0 && lines[marker - 1].trim() === WARMUP_HEADING ? marker - 1 : marker;
  const out = lines.slice(frontmatterEnd + 1, warmupStart);
  trimBlankEdges(out);
  return out;
}

function trimBlankEdges(lines: string[]): void {
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
}

function parseFrontmatter(text: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new SquareError('invalid_args', 'Invalid square: missing frontmatter.');
  return match[1];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isReadCursor(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    typeof value.consumedThroughIndex === 'number' &&
    Number.isInteger(value.consumedThroughIndex) &&
    value.consumedThroughIndex >= -1 &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  );
}

export function isDeliveryReceipt(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.status !== 'delivered') return false;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return false;
  if (value.reason !== undefined && value.reason !== 'reconciled') return false;
  if (value.actor !== undefined && (typeof value.actor !== 'string' || value.actor === '')) return false;
  if (value.reason === 'reconciled' && value.status !== 'delivered') return false;
  return true;
}

export function isDeliveryReceiptMap(value: unknown): boolean {
  return isObject(value) && Object.entries(value).every(([id, receipt]) => /^act_\d+$/.test(id) && isDeliveryReceipt(receipt));
}

export function isWatchLease(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value.leaseId !== 'string' || value.leaseId === '') return false;
  if (value.ownerId !== undefined && (typeof value.ownerId !== 'string' || value.ownerId === '')) return false;
  if (typeof value.heartbeatAt !== 'number' || !Number.isFinite(value.heartbeatAt)) return false;
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return false;
  if (value.expiresAt < value.heartbeatAt) return false;
  if (value.filter === undefined) return true;
  if (!isObject(value.filter)) return false;
  const participants = value.filter.participants;
  if (participants !== undefined && (!Array.isArray(participants) || !participants.every((item) => typeof item === 'string'))) return false;
  const mention = value.filter.mention;
  return mention === undefined || typeof mention === 'string';
}

export function isNotifyLease(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value.leaseId !== 'string' || value.leaseId === '') return false;
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return false;
  if (value.phase !== 'claimed' && value.phase !== 'dispatching') return false;
  if (value.attemptN !== undefined && (typeof value.attemptN !== 'number' || !Number.isInteger(value.attemptN) || value.attemptN <= 0)) return false;
  if (value.routeKind !== undefined && !isWakeRouteKind(value.routeKind)) return false;
  return value.phase !== 'dispatching' || (value.attemptN !== undefined && value.routeKind !== undefined);
}

function invalidVersionGuidance(reason: string): SquareError {
  return new SquareError('invalid_args', `${reason} This format is no longer supported. Create a new square with \`square build\`.`);
}

function parseCap(text: string): HardCap {
  const frontmatter = parseFrontmatter(text);
  const match = frontmatter.match(/^hard_cap:\s*(-1|\d+)\s*$/m);
  if (!match) throw new SquareError('invalid_args', 'Invalid square: missing hard_cap in frontmatter. Expected a positive integer or -1.');
  if (match[1] === '-1') return null;
  const hardCap = parseInt(match[1], 10);
  if (hardCap <= 0) throw new SquareError('invalid_args', 'Invalid square: hard_cap must be a positive integer or -1.');
  return hardCap;
}

function parseThrottle(text: string): number | undefined {
  const frontmatter = parseFrontmatter(text);
  const match = frontmatter.match(/^throttle_per_minute:\s*(\d+)\s*$/m);
  if (!match) return undefined;
  const throttle = parseInt(match[1], 10);
  if (throttle <= 0) throw new SquareError('invalid_args', 'Invalid square: throttle_per_minute must be a positive integer.');
  return throttle;
}

export function parseFormatVersion(text: string): number {
  const frontmatter = parseFrontmatter(text);
  const match = frontmatter.match(/^format_version:\s*(\d+)\s*$/m);
  if (!match) {
    throw invalidVersionGuidance('Invalid square: missing format_version in frontmatter.');
  }
  const version = parseInt(match[1], 10);
  if (version !== CURRENT_FORMAT_VERSION) {
    throw invalidVersionGuidance(`Invalid square: unsupported format_version ${version} (expected ${CURRENT_FORMAT_VERSION}).`);
  }
  return version;
}

export function parseSquare(text: string): SquareDoc {
  parseFormatVersion(text);
  const runtime = emptyRuntimeState(0);
  const parsedActs = parseActs(text);
  runtime.nextActIndex = parsedActs.nextActIndex;
  return {
    hardCap: parseCap(text),
    throttlePerMinute: parseThrottle(text),
    preamble: parsePreamble(text),
    warmup: parseWarmup(text),
    acts: parsedActs.acts,
    runtime,
  };
}

export function loadSquare(squarePath: string): SquareDoc {
  let text: string;
  try {
    text = fs.readFileSync(squarePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SquareError('not_found', `square file not found: ${squarePath}`);
    }
    throw err;
  }
  const doc = parseSquare(text);
  const markdownRuntime = doc.runtime;
  const sidecar = loadRuntimeSidecar(squarePath, markdownRuntime);
  // Markdown owns the activity history; runtime state owns delivery metadata.
  // Preserve whichever history boundary is furthest ahead so a missing or
  // stale sidecar can never cause an index to be reused.
  doc.runtime = mergeRuntimeState(markdownRuntime, sidecar);
  return doc;
}

function isSquareMarker(line: string): boolean {
  return /^<!-- square:(warmup|activities) -->$/.test(line.trim());
}

function findActivitiesMarker(lines: string[], after = -1): number {
  return lines.findIndex((line, index) => index > after && line.trim() === ACTIVITIES_MARKER);
}

export function parseWarmup(text: string): string[] {
  const lines = text.split('\n');
  const marker = lines.findIndex((line) => line.trim() === WARMUP_MARKER);
  if (marker < 0) throw new SquareError('invalid_args', 'Invalid square: missing embedded warmup.');
  const start = marker > 0 && lines[marker - 1].trim() === WARMUP_HEADING ? marker - 1 : marker;
  const endMarker = findActivitiesMarker(lines, start);
  if (endMarker < 0) throw new SquareError('invalid_args', 'Invalid square: missing ACTIVITIES section.');
  const end =
    lines[endMarker].trim() === ACTIVITIES_MARKER && endMarker > 0 && lines[endMarker - 1].trim() === ACTIVITIES_HEADING
      ? endMarker - 1
      : endMarker;
  const out = lines.slice(start, end).filter((line) => !isSquareMarker(line));
  trimSection(out);
  return out;
}

interface ParsedActs {
  acts: StoredAct[];
  nextActIndex: number;
}

export interface ParsedActMarker {
  index: number;
  kind?: string;
  actor?: string;
  at?: number;
  reach?: Reach;
  reply?: number;
}

function parseReach(value: unknown): Reach | undefined {
  if (value === undefined) return undefined;
  if (value === 'bell') return 'bell';
  if (isObject(value) && typeof value.beside === 'string') return { beside: value.beside };
  throw new SquareError('invalid_args', 'Invalid square: malformed act reach metadata.');
}

export function parseActMarker(line: string | undefined): ParsedActMarker | null {
  if (line === undefined || !line.startsWith(ACT_MARKER_PREFIX)) return null;
  const match = line.match(/^<!-- square:act\s+(\{.*\})\s*-->$/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new SquareError('invalid_args', 'Invalid square: malformed act marker JSON.');
  }
  if (!isObject(parsed)) throw new SquareError('invalid_args', 'Invalid square: act marker is missing index metadata.');
  const index = parsed.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new SquareError('invalid_args', 'Invalid square: act marker is missing index metadata.');
  }
  return {
    index,
    ...(typeof parsed.kind === 'string' ? { kind: parsed.kind } : {}),
    ...(typeof parsed.actor === 'string' ? { actor: parsed.actor } : {}),
    ...(typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? { at: parsed.at } : {}),
    ...(parsed.reach !== undefined ? { reach: parseReach(parsed.reach) } : {}),
    ...(parsed.reply !== undefined ? { reply: parseReply(parsed.reply) } : {}),
  };
}

function parseReply(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SquareError('invalid_args', 'Invalid square: malformed act reply metadata.');
  }
  return value;
}

function normalizeActMeta(marker: ParsedActMarker, kind: string, actor: string, head: StoredActHead): { index: number; reach?: Reach; reply?: number } {
  if (marker.kind === undefined || marker.actor === undefined) {
    throw new SquareError('invalid_args', 'Invalid square: act marker is missing kind/actor metadata.');
  }
  if (marker.kind !== kind) {
    throw new SquareError('invalid_args', `Invalid square: act marker kind ${marker.kind} does not match ${kind}.`);
  }
  if (!sameName(marker.actor, actor)) {
    throw new SquareError('invalid_args', `Invalid square: act marker actor ${marker.actor} does not match ${actor}.`);
  }
  if (marker.at === undefined) {
    throw new SquareError('invalid_args', `Invalid square: act marker is missing timestamp for ${kind} ${actor}.`);
  }
  if (marker.at !== head.at) {
    throw new SquareError('invalid_args', `Invalid square: act marker timestamp does not match ${kind} ${actor}.`);
  }
  if (marker.reply !== undefined && kind !== 'say') {
    throw new SquareError('invalid_args', 'Invalid square: only say acts may reply to another activity.');
  }
  return { index: marker.index, ...(marker.reach !== undefined ? { reach: marker.reach } : {}), ...(marker.reply !== undefined ? { reply: marker.reply } : {}) };
}

export function activitiesSourceLines(text: string): string[] {
  const lines = text.split('\n');
  const marker = findActivitiesMarker(lines);
  if (marker < 0) throw new SquareError('invalid_args', 'Invalid square: missing ACTIVITIES section.');
  let start = marker + 1;
  while (start < lines.length && (lines[start] === '' || isSquareMarker(lines[start]))) start++;
  return lines.slice(start);
}

export function parseParticipantHeading(line: string): string | null {
  const match = line.match(/^### (.+)\s*$/);
  return match ? match[1] : null;
}

export function parseActLine(line: string, actor: string): StoredActHead | null {
  const match = line.match(/^_(say|join|done|hold|resume) · ([^_]+)_\s*$/);
  if (!match) return null;
  const at = parseTimestamp(match[2]);
  if (!Number.isFinite(at) || !V2_KINDS.has(match[1])) return null;
  return { kind: match[1] as StoredAct['kind'], actor, at };
}

function isActSeparator(lines: string[], index: number): boolean {
  return lines[index]?.trim().startsWith(ACT_MARKER_PREFIX) === true;
}

function parseActBlock(blockLines: string[]): StoredAct {
  let i = 0;
  const marker = parseActMarker(blockLines[i]?.trim());
  if (!marker) throw new SquareError('invalid_args', `Invalid square: expected act marker, got: ${blockLines[i] ?? ''}`);
  i++;

  const actor = parseParticipantHeading(blockLines[i] ?? '');
  if (!actor) throw new SquareError('invalid_args', `Invalid square: expected participant heading, got: ${blockLines[i] ?? ''}`);
  i++;
  if (blockLines[i] === '') i++;

  const head = parseActLine(blockLines[i] ?? '', actor);
  if (!head) throw new SquareError('invalid_args', `Invalid square: expected act line, got: ${blockLines[i] ?? ''}`);
  i++;
  const meta = normalizeActMeta(marker, head.kind, actor, head);

  let body = '';
  if (head.kind === 'say' || head.kind === 'done' || head.kind === 'hold') {
    if (blockLines[i] === '') i++;
    body = unquoteBody(blockLines.slice(i));
  }
  return { ...head, body, index: meta.index, ...(meta.reach !== undefined ? { reach: meta.reach } : {}), ...(meta.reply !== undefined ? { reply: meta.reply } : {}) } as StoredAct;
}

function parseActs(text: string): ParsedActs {
  const lines = activitiesSourceLines(text);
  const acts: StoredAct[] = [];
  const indexes = new Set<number>();
  let maxIndex = -1;
  let detectedFirst = -1;

  for (let i = 0; i < lines.length;) {
    if (lines[i] === '') {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !isActSeparator(lines, end)) end++;
    const act = parseActBlock(lines.slice(i, end));
    if (detectedFirst === -1) detectedFirst = act.index!;
    if (indexes.has(act.index!)) throw new SquareError('invalid_args', `Invalid square: duplicate act index ${act.index}.`);
    indexes.add(act.index!);
    maxIndex = Math.max(maxIndex, act.index!);
    acts.push(act);
    i = end;
  }

  if (indexes.size > 0) {
    const first = detectedFirst;
    if (Math.min(...indexes) !== first || indexes.size !== maxIndex - first + 1) {
      throw new SquareError('invalid_args', 'Invalid square: act indexes must be contiguous from the first retained index.');
    }
  }
  return { acts, nextActIndex: indexes.size > 0 ? maxIndex + 1 : 0 };
}

function isDivider(line: string): boolean {
  return line.trim() === '---';
}

function trimSection(lines: string[]): void {
  while (lines.length > 0 && (lines[0] === '' || isDivider(lines[0]))) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] === '' || isDivider(lines[lines.length - 1]))) lines.pop();
}

export interface DoctorProblem {
  kind: string;
  message: string;
}

export interface DoctorParsedAct {
  act: StoredAct;
  raw: string;
}

export interface DoctorQuarantinedBlock {
  raw: string;
  reason: string;
}

export interface DiagnoseResult {
  unfixable?: string;
  formatVersion?: number;
  problems: DoctorProblem[];
  hardCap: HardCap;
  throttlePerMinute?: number;
  preamble: string[];
  warmup: string[];
  acts: DoctorParsedAct[];
  quarantined: DoctorQuarantinedBlock[];
}

function unfixableResult(reason: string): DiagnoseResult {
  return {
    unfixable: reason,
    problems: [],
    hardCap: null,
    preamble: [],
    warmup: [],
    acts: [],
    quarantined: [],
  };
}

type ActBlockOutcome = { ok: true; act: StoredAct } | { ok: false; reason: string };

function tryParseV2ActBlock(blockLines: string[]): ActBlockOutcome {
  try {
    const marker = parseActMarker(blockLines[0]?.trim());
    if (!marker || marker.kind === undefined || marker.actor === undefined) return { ok: false, reason: 'act marker is missing kind/actor metadata.' };
    const actor = parseParticipantHeading(blockLines[1] ?? '');
    if (!actor) return { ok: false, reason: `act block missing participant heading, got: ${blockLines[1] ?? ''}` };
    const headLine = blockLines[2] === '' ? blockLines[3] : blockLines[2];
    if (!parseActLine(headLine ?? '', actor)) return { ok: false, reason: `act block missing or malformed timestamp line, got: ${headLine ?? ''}` };
    return { ok: true, act: parseActBlock(blockLines) };
  } catch {
    return { ok: false, reason: 'malformed act block.' };
  }
}

function detectBlockParser(line: string): ((blockLines: string[]) => ActBlockOutcome) | null {
  const trimmed = line.trim();
  if (trimmed.startsWith(ACT_MARKER_PREFIX)) return tryParseV2ActBlock;
  return null;
}

function isActBlockStart(line: string): boolean {
  return line.trim().startsWith('<!-- square:');
}

function diagnoseActs(text: string, problems: DoctorProblem[]): { acts: DoctorParsedAct[]; quarantined: DoctorQuarantinedBlock[] } {
  const lines = activitiesSourceLines(text);
  const acts: DoctorParsedAct[] = [];
  const quarantined: DoctorQuarantinedBlock[] = [];
  const seenIndexes = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === '') {
      i++;
      continue;
    }
    const parseBlock = detectBlockParser(lines[i]);
    if (!parseBlock) {
      problems.push({ kind: 'act_block', message: `expected act marker, got: ${lines[i]}` });
      let j = i + 1;
      while (j < lines.length && !isActBlockStart(lines[j])) j++;
      quarantined.push({ raw: lines.slice(i, j).join('\n'), reason: 'expected current-format act marker' });
      i = j;
      continue;
    }
    const blockStart = i;
    let j = i + 1;
    while (j < lines.length && !isActBlockStart(lines[j])) j++;
    const blockLines = lines.slice(blockStart, j);
    const outcome = parseBlock(blockLines);
    if (outcome.ok) {
      const index = outcome.act.index!;
      if (seenIndexes.has(index)) problems.push({ kind: 'duplicate_index', message: `duplicate act index ${index}.` });
      seenIndexes.add(index);
      acts.push({ act: outcome.act, raw: blockLines.join('\n') });
    } else {
      problems.push({ kind: 'act_block', message: outcome.reason });
      quarantined.push({ raw: blockLines.join('\n'), reason: outcome.reason });
    }
    i = j;
  }
  const uniqueIndexes = [...seenIndexes].sort((a, b) => a - b);
  if (uniqueIndexes.length > 0) {
    const min = uniqueIndexes[0];
    const max = uniqueIndexes[uniqueIndexes.length - 1];
    if (max - min + 1 !== uniqueIndexes.length) {
      problems.push({ kind: 'non_contiguous_indexes', message: 'act indexes are not contiguous.' });
    }
  }
  return { acts, quarantined };
}

export function diagnoseSquare(text: string): DiagnoseResult {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!fmMatch) return unfixableResult('cannot locate frontmatter: missing opening/closing "---" delimiters.');
  const frontmatter = fmMatch[1];
  const lines = text.split('\n');
  if (!lines.some((line) => line.trim() === WARMUP_MARKER) || !lines.some((line) => line.trim() === ACTIVITIES_MARKER)) {
    return unfixableResult('cannot locate the warmup/activities section markers; the act stream boundaries are unknown.');
  }

  const problems: DoctorProblem[] = [];
  const fvMatch = frontmatter.match(/^format_version:\s*(\d+)\s*$/m);
  const formatVersion = fvMatch ? parseInt(fvMatch[1], 10) : undefined;
  if (formatVersion === undefined) return unfixableResult('missing format_version in frontmatter. Create a new square with `square build`.');
  if (formatVersion !== CURRENT_FORMAT_VERSION) return unfixableResult(`format_version ${formatVersion} is no longer supported. Create a new square with \`square build\`.`);

  let hardCap: HardCap = null;
  const hcMatch = frontmatter.match(/^hard_cap:\s*(-1|\d+)\s*$/m);
  if (!hcMatch) problems.push({ kind: 'hard_cap', message: 'missing or malformed hard_cap in frontmatter.' });
  else hardCap = hcMatch[1] === '-1' ? null : parseInt(hcMatch[1], 10);

  let throttlePerMinute: number | undefined;
  const tMatch = frontmatter.match(/^throttle_per_minute:\s*(\d+)\s*$/m);
  if (tMatch) throttlePerMinute = parseInt(tMatch[1], 10);

  let preamble: string[] = [];
  try {
    preamble = parsePreamble(text);
  } catch (err) {
    problems.push({ kind: 'preamble', message: err instanceof Error ? err.message : String(err) });
  }

  let warmup: string[] = [];
  try {
    warmup = parseWarmup(text);
  } catch (err) {
    problems.push({ kind: 'warmup', message: err instanceof Error ? err.message : String(err) });
  }

  const { acts, quarantined } = diagnoseActs(text, problems);

  return {
    formatVersion,
    problems,
    hardCap,
    throttlePerMinute,
    preamble,
    warmup,
    acts,
    quarantined,
  };
}
