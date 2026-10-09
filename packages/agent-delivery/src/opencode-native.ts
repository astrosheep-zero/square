import { randomUUID } from 'node:crypto'
import { deadline, validSignal, validTimeout } from './deadline.js'
import { ConnectionError } from './errors.js'
import type { OpenCodeDeliveryResult, OpenCodeSendTextOptions } from './types.js'

/** Injected native capability. No endpoint discovery or SDK initialization. */
export interface OpenCodeSessionCapability {
  get(input: { sessionID: string }, options?: { signal: AbortSignal }): Promise<unknown>
  prompt(input: { sessionID: string; id: string; text: string; delivery: 'steer' | 'queue'; resume: true }, options?: { signal: AbortSignal }): Promise<unknown>
}
export interface OpenCodeNativeSession {
  readonly sessionId: string
  readonly session: OpenCodeSessionCapability
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const identity = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function isNativeSession(value: unknown, sessionId: string): value is Record<string, unknown> {
  return record(value) && value.id === sessionId
}

/** Validate an explicit existing identity against the receiving backend. */
export async function connectNative(options: {
  sessionId: string; session: OpenCodeSessionCapability; timeoutMs?: number; signal?: AbortSignal
}): Promise<OpenCodeNativeSession> {
  if (!record(options) || !identity(options.sessionId) || !record(options.session) ||
    typeof options.session.get !== 'function' || typeof options.session.prompt !== 'function' ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal)) throw new ConnectionError('invalid_arguments')
  const scope = deadline(options.timeoutMs, options.signal)
  try {
    scope.check()
    const session = await scope.wait(options.session.get({ sessionID: options.sessionId }, { signal: scope.signal }))
    scope.check()
    if (!isNativeSession(session, options.sessionId)) throw new ConnectionError('invalid_response')
    return { sessionId: options.sessionId, session: options.session }
  } catch (error) {
    if (scope.code !== undefined) throw new ConnectionError(scope.code)
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError('service_unavailable')
  } finally { scope.close() }
}

function admission(value: unknown, sessionId: string, inputId: string) {
  return record(value) && value.id === inputId && value.sessionID === sessionId &&
    value.type === 'user' && (value.delivery === 'steer' || value.delivery === 'queue') &&
    record(value.payload) && typeof value.payload.text === 'string' &&
    record(value.time) && typeof value.time.created === 'number' &&
    Number.isFinite(value.time.created) && value.time.created >= 0
}

export function createNativeInputId(): string { return `msg_${randomUUID()}` }

/** Submit once. Deadline/cancellation bounds waiting, not in-process native custody. */
export async function sendNativeText(target: OpenCodeNativeSession, text: string, options: OpenCodeSendTextOptions = {}): Promise<OpenCodeDeliveryResult> {
  if (!record(target) || !identity(target.sessionId) || !record(target.session) || typeof target.session.prompt !== 'function' ||
    typeof text !== 'string' || text.length === 0 || !record(options) ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal) ||
    (options.delivery !== undefined && options.delivery !== 'steer' && options.delivery !== 'queue') ||
    (options.inputId !== undefined && (typeof options.inputId !== 'string' || !options.inputId.startsWith('msg_') || options.inputId.length <= 4))) {
    throw new TypeError('Invalid sendText arguments.')
  }
  const inputId = options.inputId ?? createNativeInputId()
  const attempt = { harness: 'opencode' as const, sessionId: target.sessionId, inputId }
  const scope = deadline(options.timeoutMs, options.signal)
  let invoked = false
  try {
    scope.check()
    invoked = true
    const value = await scope.wait(target.session.prompt({
      sessionID: target.sessionId, id: inputId, text, delivery: options.delivery ?? 'steer', resume: true,
    }, { signal: scope.signal }))
    scope.check()
    if (!admission(value, target.sessionId, inputId)) return { ...attempt, state: 'unknown', code: 'invalid_response' }
    const receipt = value as { id: string; delivery: 'steer' | 'queue' }
    return { ...attempt, state: 'accepted', inboxId: receipt.id, delivery: receipt.delivery }
  } catch {
    return invoked ? { ...attempt, state: 'unknown', code: scope.code ?? 'transport' }
      : { ...attempt, state: 'unavailable', code: scope.code ?? 'aborted' }
  } finally { scope.close() }
}
