import { SquareError, nameKey } from './neutral.js';

export const WAKE_ROUTE_KINDS = ['opencode-server', 'codex-queue', 'claude-native', 'paseo', 'http'] as const;
export type WakeRouteKind = typeof WAKE_ROUTE_KINDS[number];
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type MessageMetadata = Readonly<Record<string, JsonValue>>;
export const MESSAGE_METADATA_MAX_BYTES = 16 * 1024;
export const MESSAGE_METADATA_MAX_DEPTH = 256;

/** Validate the bounded, lossless JSON object carried by a message. */
export function validateMessageMetadata(value: unknown): MessageMetadata | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new SquareError('invalid_args', 'Activity metadata must be a non-null JSON object.');
  type Frame = { readonly value: unknown; readonly depth: number; readonly exit?: object };
  const visiting = new Set<object>();
  const stack: Frame[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit !== undefined) { visiting.delete(frame.exit); continue; }
    const item = frame.value;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new SquareError('invalid_args', 'Activity metadata must contain only finite JSON values.');
      continue;
    }
    if (typeof item !== 'object') throw new SquareError('invalid_args', 'Activity metadata must contain only JSON values.');
    if (frame.depth > MESSAGE_METADATA_MAX_DEPTH)
      throw new SquareError('invalid_args', `Activity metadata nesting cannot exceed ${MESSAGE_METADATA_MAX_DEPTH} levels.`);
    if (visiting.has(item)) throw new SquareError('invalid_args', 'Activity metadata cannot contain a cycle.');
    visiting.add(item);
    stack.push({ value: item, depth: frame.depth, exit: item });
    if (Array.isArray(item)) {
      if (Object.getOwnPropertySymbols(item).length > 0 || Object.keys(item).length !== item.length)
        throw new SquareError('invalid_args', 'Activity metadata arrays must be dense JSON arrays.');
      const names = Object.getOwnPropertyNames(item);
      if (names.some(name => name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= item.length)))
        throw new SquareError('invalid_args', 'Activity metadata arrays must contain only indexed values.');
      for (const key of Object.keys(item).reverse()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined || !('value' in descriptor)) throw new SquareError('invalid_args', 'Activity metadata cannot contain accessors.');
        stack.push({ value: descriptor.value, depth: frame.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null)
      throw new SquareError('invalid_args', 'Activity metadata must contain only plain JSON objects.');
    if (Object.getOwnPropertySymbols(item).length > 0)
      throw new SquareError('invalid_args', 'Activity metadata cannot contain symbol keys.');
    const names = Object.getOwnPropertyNames(item);
    if (names.some(name => !Object.prototype.propertyIsEnumerable.call(item, name)))
      throw new SquareError('invalid_args', 'Activity metadata cannot contain non-enumerable properties.');
    for (const name of names.reverse()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
      if (!('value' in descriptor)) throw new SquareError('invalid_args', 'Activity metadata cannot contain accessors.');
      stack.push({ value: descriptor.value, depth: frame.depth + 1 });
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(value)!; }
  catch { throw new SquareError('invalid_args', 'Activity metadata must contain only lossless JSON values.'); }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MESSAGE_METADATA_MAX_BYTES)
    throw new SquareError('invalid_args', `Activity metadata cannot exceed ${MESSAGE_METADATA_MAX_BYTES} UTF-8 bytes.`);
  return value as MessageMetadata;
}
export function messageMetadataHasContent(metadata: MessageMetadata | undefined): boolean {
  return metadata !== undefined && Object.keys(metadata).length > 0;
}
export interface WakeAddress {
  readonly kind: WakeRouteKind;
  readonly address: Readonly<Record<string, string>>;
}
export function isWakeRouteKind(value: unknown): value is WakeRouteKind {
  return typeof value === 'string' && (WAKE_ROUTE_KINDS as readonly string[]).includes(value);
}
export interface WakeRoute {
  epoch?: number;
  location: string;
  participant: string;
  kind: WakeRouteKind;
  address: Record<string, string>;
  updatedAt: number;
}
export function sameName(a: string, b: string): boolean { return nameKey(a) === nameKey(b); }
const TEXT_NAME_GRAPHEME_SOURCE = String.raw`[[\p{L}\p{N}\p{M}_\x2D]--[\p{Variation_Selector}]]`;
export const NAME_GRAPHEME_SOURCE = String.raw`${TEXT_NAME_GRAPHEME_SOURCE}|\p{RGI_Emoji}`;
const TEXT_NAME_PATTERN = new RegExp(`^(?:${TEXT_NAME_GRAPHEME_SOURCE})+(?:/(?:${TEXT_NAME_GRAPHEME_SOURCE})+)*$`, 'v');
const NAME_PATTERN = new RegExp(`^(?:${NAME_GRAPHEME_SOURCE})+(?:/(?:${NAME_GRAPHEME_SOURCE})+)*$`, 'v');
export function validateName(name: string): void {
  if (!name || (!TEXT_NAME_PATTERN.test(name) && !NAME_PATTERN.test(name))) {
    throw new SquareError('invalid_name', 'Invalid name: names must contain non-empty slash-separated segments using Unicode letters, digits, marks, hyphens, underscores, or complete RGI emoji graphemes.');
  }
}
