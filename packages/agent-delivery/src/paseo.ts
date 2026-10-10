import { randomUUID } from 'node:crypto'
import { deadline, validSignal, validTimeout } from './deadline.js'
import { ConnectionError } from './errors.js'
import { isIdentity, isRecord } from './guards.js'
import {
  daemonCredential,
  openPaseoClient,
  paseoHome,
  resolvePaseoDaemon,
  type PaseoCredential,
  type PaseoDaemonTarget,
} from './paseo-native.js'
import type { PaseoDeliveryResult, PaseoSendTextOptions, PaseoTarget } from './types.js'

export interface PaseoConnectExistingOptions {
  readonly harness: 'paseo'
  readonly agentId: string
  readonly endpoint?: string
  readonly password?: string
  readonly authHeader?: string
  readonly localCredential?: string
  readonly paseoHome?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

interface PaseoConnection {
  readonly target: PaseoDaemonTarget
  readonly credential: PaseoCredential
}

const connections = new WeakMap<PaseoTarget, PaseoConnection>()

/** Connect to an existing daemon and address one existing agent. Never starts or stops anything. */
export async function connectPaseo(options: PaseoConnectExistingOptions): Promise<PaseoTarget> {
  if (!isRecord(options) || options.harness !== 'paseo' || !isIdentity(options.agentId) ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal) ||
    (options.endpoint !== undefined && !isIdentity(options.endpoint)) ||
    (options.password !== undefined && !isIdentity(options.password)) ||
    (options.authHeader !== undefined && !isIdentity(options.authHeader)) ||
    (options.localCredential !== undefined && !isIdentity(options.localCredential)) ||
    (options.paseoHome !== undefined && !isIdentity(options.paseoHome))) {
    throw new ConnectionError('invalid_arguments')
  }
  const home = paseoHome(options.paseoHome)
  const target = resolvePaseoDaemon(options.endpoint, process.env, home)
  if (target === undefined) throw new ConnectionError('invalid_arguments')
  const credential = daemonCredential({ ...options, endpointPassword: target.password }, process.env, home)

  const scope = deadline(options.timeoutMs, options.signal)
  let client
  try { client = await openPaseoClient(target, credential, options.timeoutMs) }
  catch { throw new ConnectionError('service_unavailable') }
  try {
    scope.check()
    await scope.wait(client.connect())
    scope.check()
  } catch (error) {
    if (scope.code !== undefined) throw new ConnectionError(scope.code)
    if (error instanceof Error && error.name === 'DaemonAuthenticationError') throw new ConnectionError('authentication_failed')
    throw new ConnectionError('service_unavailable')
  } finally {
    scope.close()
    // A connected client owns a socket and a heartbeat timer. Nothing outlives
    // this call, so a caller's process is free to exit the moment it is done.
    await client.close().catch(() => {})
  }

  const addressed = Object.freeze({ harness: 'paseo' as const, agentId: options.agentId }) as PaseoTarget
  connections.set(addressed, { target, credential })
  return addressed
}

/**
 * Every call owns its daemon connection: one for connect to prove the endpoint
 * and credential, and one per send, closed again as soon as the daemon answers.
 */
export async function sendPaseoText(target: PaseoTarget, text: string, options: PaseoSendTextOptions = {}): Promise<PaseoDeliveryResult> {
  const connection = connections.get(target as PaseoTarget)
  if (connection === undefined || typeof text !== 'string' || text.length === 0 ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal) ||
    (options.inputId !== undefined && !isIdentity(options.inputId)) ||
    (options.delivery !== undefined && options.delivery !== 'steer')) {
    throw new TypeError('Invalid sendText arguments.')
  }
  const inputId = options.inputId ?? randomUUID()
  const attempt = { harness: 'paseo' as const, agentId: target.agentId, inputId }
  const scope = deadline(options.timeoutMs, options.signal)
  const client = await openPaseoClient(connection.target, connection.credential, options.timeoutMs)
  // The connection is the uncertainty boundary: before it, nothing was written.
  let connected = false
  try {
    scope.check()
    await scope.wait(client.connect())
    connected = true
    scope.check()
    await scope.wait(client.sendAgentMessage(target.agentId, text, { messageId: inputId, activeTurnBehavior: 'steer' }))
    return { ...attempt, state: 'admitted' }
  } catch (error) {
    if (scope.code !== undefined) {
      return { ...attempt, state: connected ? 'unknown' : 'unavailable', code: scope.code }
    }
    if (error instanceof Error && error.name === 'DaemonAuthenticationError') {
      return { ...attempt, state: 'unavailable', code: 'authentication_failed' }
    }
    // Only a connection that completed can carry the daemon's own answer.
    if (!connected) return { ...attempt, state: 'unavailable', code: 'transport' }
    if (error instanceof Error) {
      // A receipt still `pending` means an earlier attempt may have landed.
      if (error.message.includes('agent_request_outcome_unknown')) {
        return { ...attempt, state: 'unknown', code: 'transport' }
      }
      if (error.name === 'Error') {
        const refusal = error.message.includes('agent_request_key_conflict') ? 'key_conflict'
          : /not found/i.test(error.message) ? 'not_found' : 'refused'
        return { ...attempt, state: 'rejected', code: refusal }
      }
    }
    return { ...attempt, state: 'unknown', code: 'transport' }
  } finally {
    scope.close()
    await client.close().catch(() => {})
  }
}
