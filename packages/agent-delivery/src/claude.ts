import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { DEFAULT_TIMEOUT_MS, deadline, validSignal, validTimeout } from './deadline.js'
import { ConnectionError } from './errors.js'
import { writeClaudeNative } from './claude-native.js'
import type { ClaudeDeliveryResult, ClaudeSendTextOptions, ClaudeTarget } from './types.js'

export interface ClaudeConnectExistingOptions {
  readonly harness: 'claude'
  readonly sessionId: string
  readonly endpoint: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const endpoints = new WeakMap<ClaudeTarget, string>()
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isIdentity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Resolve an explicitly identified existing Claude native inbox; never discovers or starts one. */
export async function connectExisting(options: ClaudeConnectExistingOptions): Promise<ClaudeTarget> {
  if (!isRecord(options) || options.harness !== 'claude' || !isIdentity(options.sessionId) ||
    typeof options.endpoint !== 'string' || !isAbsolute(options.endpoint) || options.endpoint.includes('\0') ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal)) {
    throw new ConnectionError('invalid_arguments')
  }
  if (process.platform !== 'darwin') throw new ConnectionError('unsupported_platform')
  const { sessionId, endpoint } = options
  const scope = deadline(options.timeoutMs, options.signal)
  try {
    scope.check()
    const present = await scope.wait(stat(endpoint))
    scope.check()
    if (!present.isSocket()) throw new ConnectionError('service_unavailable')
    const target = Object.freeze({ harness: 'claude' as const, sessionId }) as ClaudeTarget
    endpoints.set(target, endpoint)
    return target
  } catch (error) {
    if (scope.code !== undefined) throw new ConnectionError(scope.code)
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError('service_unavailable')
  } finally { scope.close() }
}

/** Write once to Claude's next native boundary; local write is never native admission. */
export async function sendText(target: ClaudeTarget, text: string, options: ClaudeSendTextOptions = {}): Promise<ClaudeDeliveryResult> {
  if (!isRecord(target) || target.harness !== 'claude' || !endpoints.has(target as ClaudeTarget) ||
    !isIdentity(target.sessionId) || typeof text !== 'string' || !text.length || !isRecord(options) ||
    (options.delivery !== undefined && options.delivery !== 'steer') || options.inputId !== undefined ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal)) {
    throw new TypeError('Invalid Claude sendText arguments.')
  }
  const result = await writeClaudeNative(
    { sessionId: target.sessionId, endpoint: endpoints.get(target as ClaudeTarget)! }, text,
    { deadline: Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS), signal: options.signal },
  )
  const attempt = { harness: 'claude' as const, sessionId: target.sessionId }
  if (result.outcome === 'written') return { ...attempt, state: 'written' }
  if (result.outcome === 'unknown') return { ...attempt, state: 'unknown', code: result.code }
  if (result.code === 'invalid_arguments') throw new TypeError('Invalid Claude sendText arguments.')
  return { ...attempt, state: 'unavailable', code: result.code }
}
