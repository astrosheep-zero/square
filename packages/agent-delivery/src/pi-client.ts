import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { deadline, validSignal } from './deadline.js'
import { ConnectionError } from './errors.js'
import { MAX_TEXT_BYTES, VERSION, endpointValid, frame, identity, readFrame, record, waitValid } from './pi-protocol.js'
import type { PiDeliveryResult, PiSendTextOptions, PiTarget } from './types.js'

export interface PiConnectExistingOptions {
  readonly harness: 'pi'
  readonly sessionId: string
  readonly endpoint: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
const endpoints = new WeakMap<PiTarget, string>()
const timeoutValid = (value: unknown) => value === undefined || waitValid(value)

/** One socket/one request. No automatic retry. Write attempt is the uncertainty boundary. */
async function request(endpoint: string, body: unknown, timeoutMs?: number, signal?: AbortSignal) {
  const scope = deadline(timeoutMs, signal)
  let dispatched = false
  let socket: ReturnType<typeof createConnection> | undefined
  let detach: (() => void) | undefined
  try {
    scope.check()
    const bytes = frame(body)
    const response = await scope.wait(new Promise<unknown>((resolve, reject) => {
      socket = createConnection(endpoint)
      socket.on('error', () => reject(new Error()))
      socket.on('close', () => reject(new Error()))
      detach = readFrame(socket, resolve, () => reject(new ConnectionError('invalid_response')))
      socket.once('connect', () => {
        if (scope.signal.aborted) return
        // Conservative: an attempted write can have reached the native receiver even on later error.
        dispatched = true
        socket!.write(bytes, (error) => { if (error) reject(new Error()) })
      })
    }))
    return { response, dispatched }
  } catch (error) {
    const code: 'aborted' | 'timeout' | 'invalid_response' | 'transport' = scope.code ??
      (error instanceof ConnectionError ? 'invalid_response' : 'transport')
    return { dispatched, code }
  } finally {
    detach?.()
    socket?.destroy()
    scope.close()
  }
}

export async function connectPi(options: PiConnectExistingOptions): Promise<PiTarget> {
  if (!record(options) || options.harness !== 'pi' || !identity(options.sessionId) ||
    !endpointValid(options.endpoint) || !timeoutValid(options.timeoutMs) || !validSignal(options.signal)) {
    throw new ConnectionError('invalid_arguments')
  }
  if (process.platform !== 'darwin') throw new ConnectionError('unsupported_platform')
  const answer = await request(options.endpoint, { protocol: VERSION, harness: 'pi', op: 'hello', sessionId: options.sessionId },
    options.timeoutMs, options.signal)
  if (answer.code !== undefined) throw new ConnectionError(answer.code === 'transport' ? 'service_unavailable' : answer.code)
  const value = answer.response
  if (record(value) && value.protocol === VERSION && value.state === 'rejected' && value.code === 'wrong_session') {
    throw new ConnectionError('session_not_found')
  }
  if (!record(value) || value.protocol !== VERSION || value.harness !== 'pi' || value.sessionId !== options.sessionId) {
    throw new ConnectionError('invalid_response')
  }
  const target = Object.freeze({ harness: 'pi' as const, sessionId: options.sessionId }) as PiTarget
  endpoints.set(target, options.endpoint)
  return target
}

export async function sendPiText(target: PiTarget, text: string, options: PiSendTextOptions = {}): Promise<PiDeliveryResult> {
  if (!record(target) || !endpoints.has(target as unknown as PiTarget) || typeof text !== 'string' || text.length === 0 ||
    Buffer.byteLength(text) > MAX_TEXT_BYTES || !record(options) || !timeoutValid(options.timeoutMs) ||
    !validSignal(options.signal) || options.inputId !== undefined ||
    (options.delivery !== undefined && options.delivery !== 'steer' && options.delivery !== 'queue')) {
    throw new TypeError('Invalid sendText arguments.')
  }
  const inputId = randomUUID()
  const delivery = options.delivery ?? 'steer'
  const attempt = { harness: 'pi' as const, sessionId: target.sessionId, inputId }
  const body = { protocol: VERSION, harness: 'pi', op: 'send',
    sessionId: target.sessionId, inputId, text, delivery, timeoutMs: options.timeoutMs ?? 5_000 }
  frame(body) // Reject excessive JSON escaping before opening any socket.
  const answer = await request(endpoints.get(target)!, body, options.timeoutMs, options.signal)
  if (answer.code !== undefined) {
    return { ...attempt, state: answer.dispatched ? 'unknown' : 'unavailable', code: answer.code }
  }
  const value = answer.response
  if (record(value) && value.protocol === VERSION) {
    if (value.state === 'rejected' && ['wrong_session', 'invalid_request', 'duplicate_inflight_id'].includes(value.code as string)) {
      return { ...attempt, state: 'rejected', code: value.code as 'wrong_session' | 'invalid_request' | 'duplicate_inflight_id' }
    }
    if (value.harness === 'pi' && value.sessionId === target.sessionId && value.inputId === inputId && value.delivery === delivery) {
      if (value.state === 'observed' && value.evidence === 'message_end') {
        return { ...attempt, state: 'observed', evidence: 'message_end', delivery }
      }
      if (value.state === 'unknown' && ['timeout', 'transport', 'session_replaced', 'native_call'].includes(value.code as string)) {
        return { ...attempt, state: 'unknown', code: value.code as 'timeout' | 'transport' | 'session_replaced' | 'native_call' }
      }
    }
  }
  return { ...attempt, state: 'unknown', code: 'invalid_response' }
}
