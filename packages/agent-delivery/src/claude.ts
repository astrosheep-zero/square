import { randomUUID } from 'node:crypto'
import { deadline, validSignal, validTimeout } from './deadline.js'
import { ConnectionError, DeliveryError } from './errors.js'
import { isIdentity, isRecord } from './guards.js'
import { parseLocalEndpoint, type LocalEndpoint } from './local-endpoint.js'
import { writeClaudeNative } from './claude-native.js'
import { resolveClaudeToken } from './claude-auth.js'
import type { ClaudeDeliveryResult, ClaudeSendTextOptions, ClaudeTarget } from './types.js'

export interface ClaudeConnectExistingOptions {
  readonly harness: 'claude'
  readonly sessionId: string
  readonly endpoint: string
  readonly token?: string
  readonly claudeHome?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

interface ClaudeCoordinate { readonly endpoint: string; readonly token?: string; readonly claudeHome?: string }
const coordinates = new WeakMap<ClaudeTarget, ClaudeCoordinate>()

/** Resolve an explicitly identified existing Claude native inbox; never discovers or starts one. */
export async function connectExisting(options: ClaudeConnectExistingOptions): Promise<ClaudeTarget> {
  if (!isRecord(options) || options.harness !== 'claude' || !isIdentity(options.sessionId) ||
    typeof options.endpoint !== 'string' || options.endpoint.includes('\0') ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal)) throw new ConnectionError('invalid_arguments')
  let endpoint: LocalEndpoint
  try { endpoint = parseLocalEndpoint(options.endpoint) } catch { throw new ConnectionError('invalid_arguments') }
  if (!(process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32')) throw new ConnectionError('unsupported_platform')
  if (process.platform === 'win32' ? endpoint.kind !== 'pipe' : endpoint.kind !== 'unix') throw new ConnectionError('invalid_arguments')
  const scope = deadline(options.timeoutMs, options.signal)
  try {
    scope.check()
    // The ambient environment and platform are the only auth coordinates here.
    const token = await resolveClaudeToken({ endpoint, token: options.token, claudeHome: options.claudeHome })
    scope.check()
    const target = Object.freeze({ harness: 'claude' as const, sessionId: options.sessionId }) as ClaudeTarget
    coordinates.set(target, { endpoint: options.endpoint, token, claudeHome: options.claudeHome })
    return target
  } catch (error) {
    if (scope.code !== undefined) throw new ConnectionError(scope.code)
    if (error instanceof ConnectionError) throw error
    if (error instanceof DeliveryError) throw new ConnectionError(error.code)
    throw new ConnectionError('invalid_response')
  } finally { scope.close() }
}

/** Write once to Claude's next native boundary; local write is never native admission. */
export async function sendText(target: ClaudeTarget, text: string, options: ClaudeSendTextOptions = {}): Promise<ClaudeDeliveryResult> {
  const coordinate = isRecord(target) ? coordinates.get(target as ClaudeTarget) : undefined
  if (!coordinate || target.harness !== 'claude' || !isIdentity(target.sessionId) || typeof text !== 'string' || !text.length || !isRecord(options) ||
    (options.delivery !== undefined && options.delivery !== 'steer') || options.inputId !== undefined ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal)) throw new TypeError('Invalid Claude sendText arguments.')
  const messageId = randomUUID()
  const result = await writeClaudeNative({ ...coordinate, sessionId: target.sessionId, messageId }, text,
    { deadline: Date.now() + (options.timeoutMs ?? 5_000), signal: options.signal })
  const attempt = { harness: 'claude' as const, sessionId: target.sessionId }
  if (result.outcome === 'written') return { ...attempt, state: 'written', messageId }
  if (result.outcome === 'unknown') return { ...attempt, state: 'unknown', code: result.code }
  if (result.code === 'invalid_arguments') throw new TypeError('Invalid Claude sendText arguments.')
  return { ...attempt, state: 'unavailable', code: result.code }
}
