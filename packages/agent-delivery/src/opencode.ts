import { isAbsolute } from 'node:path'
import { OpenCode } from '@opencode/client'
import { Service, type Endpoint } from '@opencode/client/service'
import { deadline, validSignal, validTimeout } from './deadline.js'
import { ConnectionError } from './errors.js'
import { isIdentity, isRecord } from './guards.js'
import { isNativeSession, sendNativeText } from './opencode-native.js'
import type { OpenCodeDeliveryResult, OpenCodeTarget, OpenCodeSendTextOptions } from './types.js'

export interface OpenCodeConnectExistingOptions {
  readonly harness: 'opencode'
  readonly sessionId: string
  readonly endpoint?: Endpoint
  readonly registrationFile?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const endpoints = new WeakMap<OpenCodeTarget, Endpoint>()
const isV2 = (version: string) => /^2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)

function endpointValid(value: unknown): value is Endpoint {
  if (!isRecord(value) || typeof value.url !== 'string') return false
  try {
    const url = new URL(value.url)
    // Secrets belong only in auth, never URL userinfo/query/fragment. No redirects.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false
  } catch { return false }
  return value.auth === undefined || (isRecord(value.auth) && value.auth.type === 'basic' &&
    typeof value.auth.username === 'string' && typeof value.auth.password === 'string')
}

/** SDK transport observation: never parse or expose arbitrary error bodies. */
function transport(endpoint: Endpoint, scope: Pick<ReturnType<typeof deadline>, 'check'>) {
  let dispatched = false
  let status: number | undefined
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
    fetch: async (input, init) => {
      scope.check()
      dispatched = true
      status = undefined
      const response = await globalThis.fetch(input, { ...init, redirect: 'manual' })
      status = response.status
      return response
    },
  })
  return { client, get dispatched() { return dispatched }, get status() { return status } }
}

function connectionFailure(status: number | undefined, phase: 'health' | 'session'): ConnectionError {
  if (status === 401 || status === 403) return new ConnectionError('authentication_failed', status)
  if (status === 404 && phase === 'session') return new ConnectionError('session_not_found', status)
  if (status !== undefined && status !== 200) return new ConnectionError('http_rejection', status)
  return new ConnectionError(status === 200 ? 'invalid_response' : 'service_unavailable')
}

/** Resolve an existing service and persisted session. Never starts or stops a service. */
export async function connectExisting(options: OpenCodeConnectExistingOptions): Promise<OpenCodeTarget> {
  if (!isRecord(options) || options.harness !== 'opencode' || !isIdentity(options.sessionId) ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal) ||
    (options.endpoint !== undefined && options.registrationFile !== undefined) ||
    (options.endpoint !== undefined && !endpointValid(options.endpoint)) ||
    (options.registrationFile !== undefined &&
      (typeof options.registrationFile !== 'string' || !isAbsolute(options.registrationFile)))) {
    throw new ConnectionError('invalid_arguments')
  }
  const scope = deadline(options.timeoutMs, options.signal)
  let current: ReturnType<typeof transport> | undefined
  let phase: 'health' | 'session' = 'health'
  try {
    scope.check()
    const endpoint = options.endpoint ?? await scope.wait(Service.discover({
      file: options.registrationFile,
      version: isV2,
    }))
    // Discover may finish later than the caller deadline: never continue from it.
    scope.check()
    if (endpoint === undefined) throw new ConnectionError('service_unavailable')
    if (!endpointValid(endpoint)) throw new ConnectionError('invalid_response')
    const privateEndpoint: Endpoint = {
      url: endpoint.url,
      ...(endpoint.auth === undefined ? {} : { auth: { ...endpoint.auth } }),
    }
    current = transport(privateEndpoint, scope)
    const info: unknown = await scope.wait(current.client.server.info({ signal: scope.signal }))
    scope.check()
    if (!isRecord(info) || typeof info.version !== 'string' ||
      !Number.isInteger(info.pid) || (info.pid as number) < 0) throw new ConnectionError('invalid_response')
    if (!isV2(info.version)) throw new ConnectionError('unsupported_version')
    phase = 'session'
    const session: unknown = await scope.wait(current.client.session.get(
      { sessionID: options.sessionId }, { signal: scope.signal },
    ))
    scope.check()
    if (!isNativeSession(session, options.sessionId)) throw new ConnectionError('invalid_response')
    const target = Object.freeze({ harness: 'opencode' as const, sessionId: options.sessionId }) as OpenCodeTarget
    endpoints.set(target, privateEndpoint)
    return target
  } catch (error) {
    if (scope.code !== undefined) throw new ConnectionError(scope.code)
    if (error instanceof ConnectionError) throw error
    throw connectionFailure(current?.status, phase)
  } finally { scope.close() }
}

/** Submit once through the shared native sender; HTTP metadata alone refines rejection. */
export async function sendText(target: OpenCodeTarget, text: string, options: OpenCodeSendTextOptions = {}): Promise<OpenCodeDeliveryResult> {
  if (!isRecord(target) || !endpoints.has(target as unknown as OpenCodeTarget)) {
    throw new TypeError('Invalid sendText arguments.')
  }
  const current = transport(endpoints.get(target)!, { check() {} })
  const result = await sendNativeText({ sessionId: target.sessionId, session: current.client.session }, text, options)
  if (result.state !== 'unknown') return result
  // Only native validation/auth/not-found/conflict responses establish rejection.
  // A proxy or backend can fail after durable admission, including with a 5xx.
  if (current.status !== undefined && [400, 401, 403, 404, 409].includes(current.status)) {
    return { harness: result.harness, sessionId: result.sessionId, inputId: result.inputId,
      state: 'rejected', code: 'http_rejection', status: current.status }
  }
  if (!current.dispatched) return { ...result, state: 'unavailable', code: result.code === 'timeout' ? 'timeout' : 'aborted' }
  return { ...result, code: current.status === 200 && result.code === 'transport' ? 'invalid_response' : result.code }
}
