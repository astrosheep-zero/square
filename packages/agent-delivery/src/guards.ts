/**
 * The two structure checks every harness front door repeats: a plain object and a
 * non-empty identity string. They live here once instead of once per transport.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
