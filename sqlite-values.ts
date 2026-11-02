import { SquareError, nameKey, type FactPage, type IndexPage } from './neutral.js';
// All strings, including identity keys, are JSON encoded before SQLite binding.
export type Row = Record<string, string | number | null>;
export const encode = JSON.stringify;
export const key = (name: string): string => encode(nameKey(name));
export function invalidArtifact(detail: string): SquareError {
    return new SquareError('invalid_args', `Invalid square artifact: ${detail}`);
}
export function requireFact(ok: unknown, detail = 'row is malformed.'): asserts ok {
    if (!ok)
        throw invalidArtifact(detail);
}
export function integer(value: unknown, minimum = 0): number {
    requireFact(Number.isSafeInteger(value) && (value as number) >= minimum);
    return value as number;
}
export function finite(value: unknown): number {
    requireFact(typeof value === 'number' && Number.isFinite(value));
    return value as number;
}
export function string(value: unknown, nonempty = false): string {
    requireFact(typeof value === 'string' && (!nonempty || value.length > 0));
    return value as string;
}
export function json(value: unknown): unknown {
    try {
        return JSON.parse(string(value));
    }
    catch {
        throw invalidArtifact('row contains invalid JSON.');
    }
}
export function object(value: unknown): Record<string, unknown> {
    requireFact(typeof value === 'object' && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
}
export function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    const result = object(value);
    requireFact(required.every(k => Object.hasOwn(result, k)) && Object.keys(result).every(k => required.includes(k) || optional.includes(k)));
    return result;
}
export function strings(value: unknown): string[] {
    requireFact(Array.isArray(value) && value.every(v => typeof v === 'string'));
    return value as string[];
}
export function decoded(value: unknown, nonempty = false): string {
    const result = string(json(value), nonempty);
    requireFact(encode(result) === value, 'string encoding is malformed.');
    return result;
}
export function immutable<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const item of Object.values(value))
            immutable(item);
        Object.freeze(value);
    }
    return value;
}
// Sorted object keys express small-value structural equality, never whole-state comparison.
export function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        requireFact(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value), 'value contains a non-finite or unsupported JSON value.');
        return encode(value);
    }
    if (Array.isArray(value))
        return '[' + value.map(stableJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => encode(k) + ':' + stableJson((value as Record<string, unknown>)[k])).join(',') + '}';
}
export function pageRows<T>(rows: Row[], page: IndexPage, decode: (row: Row) => T): FactPage<T> {
    const hasMore = rows.length > page.limit;
    if (hasMore)
        rows.pop();
    if (page.edge === 'newest')
        rows.reverse();
    return immutable({ items: rows.map(decode), hasMore });
}
export function pageLimit(page: IndexPage): number {
    requireFact(page.edge === 'oldest' || page.edge === 'newest');
    return Math.min(integer(page.limit, 1) + 1, Number.MAX_SAFE_INTEGER);
}
