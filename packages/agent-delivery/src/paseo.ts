import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { DaemonClient, DaemonClientConfig, WebSocketFactory } from '@getpaseo/client/internal/daemon-client'
import { DEFAULT_TIMEOUT_MS, deadline, validSignal, validTimeout } from './deadline.js'
import { ConnectionError } from './errors.js'
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

type PaseoSdk = typeof import('@getpaseo/client/internal/daemon-client')

interface PaseoConnection {
  readonly sdk: PaseoSdk
  readonly endpoint: PaseoEndpoint
  readonly auth: Partial<DaemonClientConfig>
}

const connections = new WeakMap<PaseoTarget, PaseoConnection>()
let clientSequence = 0

const DEFAULT_HOST = '127.0.0.1:6767'
/** The daemon writes a 32-byte base64url local credential; anything else is not one. */
const LOCAL_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const isIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

function paseoHome(options: PaseoConnectExistingOptions, env: NodeJS.ProcessEnv): string {
  if (isIdentity(options.paseoHome)) return expandHome(options.paseoHome.trim())
  if (isIdentity(env.PASEO_HOME)) return expandHome(env.PASEO_HOME.trim())
  return join(homedir(), '.paseo')
}

/**
 * The same daemon spellings the Paseo CLI accepts: IPC URIs, named pipes,
 * absolute socket paths, bare ports and `host:port`.
 */
function normalizeHost(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = raw.trim()
  if (value.startsWith('unix://') || value.startsWith('pipe://') || value.startsWith('tcp://')) return value
  if (value.startsWith('\\\\.\\pipe\\')) return `pipe://${value}`
  if (value.startsWith('/') || value.startsWith('~/')) return `unix://${expandHome(value)}`
  if (/^\d+$/.test(value)) return `127.0.0.1:${value}`
  return value.includes(':') ? value : undefined
}

interface PaseoEndpoint {
  readonly url: string
  /** Present for IPC targets; the daemon speaks WebSocket over a socket path. */
  readonly socketPath?: string
}

function endpointOf(host: string): PaseoEndpoint | undefined {
  if (host.startsWith('unix://') || host.startsWith('pipe://')) {
    const unix = host.startsWith('unix://')
    if (unix && process.platform === 'win32') return undefined
    const socketPath = expandHome(host.slice(unix ? 'unix://'.length : 'pipe://'.length).trim())
    if (socketPath === '') return undefined
    return { url: unix ? `ws+unix://${socketPath}:/ws` : 'ws://localhost/ws', socketPath }
  }
  if (host.startsWith('tcp://')) {
    let uri: URL
    try { uri = new URL(host) } catch { return undefined }
    const hostname = uri.hostname.replace(/^\[|\]$/g, '')
    if (hostname === '') return undefined
    const address = `${hostname.includes(':') ? `[${hostname}]` : hostname}:${uri.port || '6767'}`
    return { url: `${uri.searchParams.get('ssl') === 'true' ? 'wss' : 'ws'}://${address}/ws` }
  }
  return { url: `ws://${host.replace(/\/$/, '')}/ws` }
}

/** The running daemon's own listen address, then the documented TCP fallback. */
function defaultHost(home: string): string {
  for (const file of ['paseo.pid', 'config.json']) {
    try {
      const state = JSON.parse(readFileSync(join(home, file), 'utf8')) as {
        listen?: unknown; sockPath?: unknown; daemon?: { listen?: unknown }
      }
      const host = normalizeHost(state.daemon?.listen ?? state.listen ?? state.sockPath)
      if (host !== undefined) return host
    } catch { /* absent or unreadable */ }
  }
  return DEFAULT_HOST
}

function hostOf(options: PaseoConnectExistingOptions, env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (options.endpoint !== undefined) return normalizeHost(options.endpoint)
  const fromEnv = normalizeHost(env.PASEO_HOST)
  return fromEnv ?? defaultHost(home)
}

function readLocalCredential(home: string): string | undefined {
  try {
    const token = readFileSync(join(home, 'local-credential'), 'utf8').trim()
    return LOCAL_CREDENTIAL.test(token) ? token : undefined
  } catch { return undefined }
}

/** Explicit credential first, then the daemon's own local credential, then the password. */
function credential(options: PaseoConnectExistingOptions, env: NodeJS.ProcessEnv, home: string): Partial<DaemonClientConfig> {
  if (isIdentity(options.authHeader)) return { authHeader: options.authHeader }
  if (isIdentity(options.password)) return { password: options.password }
  if (isIdentity(options.localCredential)) return { localCredential: () => options.localCredential }
  const token = readLocalCredential(home)
  if (token !== undefined) return { localCredential: () => token }
  if (isIdentity(env.PASEO_PASSWORD)) return { password: env.PASEO_PASSWORD.trim() }
  return {}
}

/** `ws` carries the daemon's auth headers and, for IPC targets, its socket path. */
function webSocketFactory(socketPath: string | undefined): WebSocketFactory {
  return (url, options) => new WebSocket(url, options?.protocols, {
    headers: options?.headers,
    ...(socketPath === undefined ? {} : { socketPath }),
  }) as unknown as ReturnType<WebSocketFactory>
}

/** A daemon connection is per call: it is closed again before the caller gets control. */
function openClient(sdk: PaseoSdk, endpoint: PaseoEndpoint, credential: Partial<DaemonClientConfig>, timeoutMs?: number): DaemonClient {
  return new sdk.DaemonClient({
    url: endpoint.url,
    clientId: `agent-delivery-${process.pid}-${Date.now()}-${++clientSequence}`,
    clientType: 'cli',
    appVersion: 'agent-delivery',
    ...credential,
    connectTimeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    reconnect: { enabled: false },
    webSocketFactory: webSocketFactory(endpoint.socketPath),
  })
}

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
  const env = process.env
  const home = paseoHome(options, env)
  const host = hostOf(options, env, home)
  if (host === undefined) throw new ConnectionError('invalid_arguments')
  const endpoint = endpointOf(host)
  if (endpoint === undefined) throw new ConnectionError('invalid_arguments')

  let sdk: PaseoSdk
  try { sdk = await import('@getpaseo/client/internal/daemon-client') }
  catch { throw new ConnectionError('service_unavailable') }

  const auth = credential(options, env, home)
  const scope = deadline(options.timeoutMs, options.signal)
  const client = openClient(sdk, endpoint, auth, options.timeoutMs)
  try {
    scope.check()
    await scope.wait(client.connect())
    scope.check()
  } catch (error) {
    if (scope.code !== undefined) throw new ConnectionError(scope.code)
    if (error instanceof sdk.DaemonAuthenticationError) throw new ConnectionError('authentication_failed')
    throw new ConnectionError('service_unavailable')
  } finally {
    scope.close()
    // A connected client owns a socket and a heartbeat timer. Nothing outlives
    // this call, so a caller's process is free to exit the moment it is done.
    await client.close().catch(() => {})
  }

  const target = Object.freeze({ harness: 'paseo' as const, agentId: options.agentId }) as PaseoTarget
  connections.set(target, { sdk, endpoint, auth })
  return target
}

/** The daemon answered with a refusal; the text explains which one. */
function refusal(message: string): 'key_conflict' | 'not_found' | 'refused' {
  if (message.includes('agent_request_key_conflict')) return 'key_conflict'
  return /not found/i.test(message) ? 'not_found' : 'refused'
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
  const { sdk, endpoint, auth: credentials } = connection
  const inputId = options.inputId ?? randomUUID()
  const attempt = { harness: 'paseo' as const, agentId: target.agentId, inputId }
  const scope = deadline(options.timeoutMs, options.signal)
  const client = openClient(sdk, endpoint, credentials, options.timeoutMs)
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
    if (error instanceof sdk.DaemonAuthenticationError) {
      return { ...attempt, state: 'unavailable', code: 'authentication_failed' }
    }
    // Only a connection that completed can carry the daemon's own answer.
    if (!connected) return { ...attempt, state: 'unavailable', code: 'transport' }
    if (error instanceof Error) {
      // A receipt still `pending` means an earlier attempt may have landed.
      if (error.message.includes('agent_request_outcome_unknown')) {
        return { ...attempt, state: 'unknown', code: 'transport' }
      }
      if (error.name === 'Error') return { ...attempt, state: 'rejected', code: refusal(error.message) }
    }
    return { ...attempt, state: 'unknown', code: 'transport' }
  } finally {
    scope.close()
    await client.close().catch(() => {})
  }
}
