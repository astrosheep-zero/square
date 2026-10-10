import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TIMEOUT_MS } from './deadline.js'
import { isIdentity } from './guards.js'

const DEFAULT_HOST = '127.0.0.1:6767'
/** The daemon writes a 32-byte base64url local credential; anything else is not one. */
const LOCAL_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/

/** A resolved daemon coordinate: one WebSocket URL and, for IPC, its socket path. */
export interface PaseoDaemonTarget {
  readonly url: string
  readonly socketPath?: string
  /** A password spelled into a tcp:// endpoint, when that endpoint carries one. */
  readonly password?: string
}

/** Authentication for one daemon connection; the daemon client claims at most one. */
export interface PaseoCredential {
  readonly authHeader?: string
  readonly password?: string
  readonly localCredential?: () => string | undefined
}

/** One projected timeline entry, as far as a wake boundary check reads it. */
export interface PaseoAgentTimeline {
  readonly agent?: { readonly status?: string }
  readonly entries?: readonly { readonly item: { readonly type?: string; readonly callId?: string; readonly status?: string } }[]
}

/** The daemon client subset every Paseo caller uses; the SDK stays a dynamic import. */
export interface PaseoClient {
  connect(): Promise<void>
  close(): Promise<void>
  sendAgentMessage(agentId: string, text: string, options: { messageId: string; activeTurnBehavior: 'steer' }): Promise<unknown>
  fetchAgentTimeline(agentId: string, options: { direction: 'tail'; limit: number; projection: 'projected'; timeout: number }): Promise<PaseoAgentTimeline>
}

/** The socket shape the daemon transport calls; `ws` supplies it for IPC targets. */
interface SocketLike {
  readyState: number
  send(data: string | Uint8Array | ArrayBuffer): void
  close(code?: number, reason?: string): void
  binaryType?: string
  on?(event: string, listener: (...args: unknown[]) => void): void
  off?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
  addEventListener?(event: string, listener: (event: unknown) => void): void
  removeEventListener?(event: string, listener: (event: unknown) => void): void
  onopen?: ((event: unknown) => void) | null
  onclose?: ((event: unknown) => void) | null
  onerror?: ((event: unknown) => void) | null
  onmessage?: ((event: unknown) => void) | null
}

let clientSequence = 0

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

/** `~/` expansion plus the daemon's default home directory. */
export function paseoHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PASEO_HOME
  const value = isIdentity(explicit) ? explicit.trim() : typeof fromEnv === 'string' ? fromEnv.trim() : ''
  return value === '' ? join(homedir(), '.paseo') : expandHome(value)
}

/** The daemon spellings the Paseo CLI accepts: IPC URIs, named pipes, socket paths, ports and `host:port`. */
function normalizedHost(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = raw.trim()
  if (value.startsWith('unix://') || value.startsWith('pipe://') || value.startsWith('tcp://')) return value
  if (value.startsWith('\\\\.\\pipe\\')) return `pipe://${value}`
  if (value.startsWith('/') || value.startsWith('~/')) return `unix://${expandHome(value)}`
  if (/^\d+$/.test(value)) return `127.0.0.1:${value}`
  return value.includes(':') ? value : undefined
}

/** One resolution for every Paseo caller. Never starts or stops anything. */
export function resolvePaseoDaemon(
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home = paseoHome(undefined, env),
): PaseoDaemonTarget | undefined {
  // The caller's own endpoint wins; only an absent one falls through to `PASEO_HOST`
  // and then to the daemon's own state files.
  let host = endpoint !== undefined ? normalizedHost(endpoint) : normalizedHost(env.PASEO_HOST)
  if (endpoint === undefined && host === undefined) {
    for (const file of ['paseo.pid', 'config.json']) {
      try {
        const state = JSON.parse(readFileSync(join(home, file), 'utf8')) as {
          listen?: unknown; sockPath?: unknown; daemon?: { listen?: unknown }
        }
        host = normalizedHost(state.daemon?.listen ?? state.listen ?? state.sockPath)
        if (host !== undefined) break
      } catch { /* absent or unreadable */ }
    }
    host ??= DEFAULT_HOST
  }
  if (host === undefined) return undefined

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
    const name = uri.hostname.replace(/^\[|\]$/g, '')
    if (name === '') return undefined
    const address = `${name.includes(':') ? `[${name}]` : name}:${uri.port || '6767'}`
    const password = uri.searchParams.get('password')
    return {
      url: `${uri.searchParams.get('ssl') === 'true' ? 'wss' : 'ws'}://${address}/ws`,
      ...(password === null || password === '' ? {} : { password }),
    }
  }
  return { url: `ws://${host.replace(/\/$/, '')}/ws` }
}

/** Explicit credential first, then the endpoint's own password, then the daemon's local credential, then `PASEO_PASSWORD`. */
export function daemonCredential(
  options: {
    readonly authHeader?: string
    readonly password?: string
    readonly localCredential?: string
    /** The password spelled into the resolved endpoint, when it carries one. */
    readonly endpointPassword?: string
  },
  env: NodeJS.ProcessEnv = process.env,
  home = paseoHome(undefined, env),
): PaseoCredential {
  if (isIdentity(options.authHeader)) return { authHeader: options.authHeader }
  if (isIdentity(options.password)) return { password: options.password }
  if (isIdentity(options.localCredential)) return { localCredential: () => options.localCredential }
  if (isIdentity(options.endpointPassword)) return { password: options.endpointPassword }
  try {
    const token = readFileSync(join(home, 'local-credential'), 'utf8').trim()
    if (LOCAL_CREDENTIAL.test(token)) return { localCredential: () => token }
  } catch { /* no readable local credential is not an error */ }
  const password = env.PASEO_PASSWORD
  return isIdentity(password) ? { password: password.trim() } : {}
}

/**
 * Open one daemon connection. The SDK and `ws` load only when a Paseo call actually
 * runs, so importing this module never pulls an optional peer dependency.
 */
export async function openPaseoClient(
  target: PaseoDaemonTarget,
  credential: PaseoCredential = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PaseoClient> {
  const sdk = await import('@getpaseo/client/internal/daemon-client')
  const { default: WebSocket } = await import('ws')
  return new sdk.DaemonClient({
    url: target.url,
    clientId: `agent-delivery-${process.pid}-${Date.now()}-${++clientSequence}`,
    clientType: 'cli',
    appVersion: 'agent-delivery',
    ...credential,
    connectTimeoutMs: timeoutMs,
    reconnect: { enabled: false },
    // `ws` carries the daemon's auth headers and, for IPC targets, its socket path.
    webSocketFactory: (url: string, options?: { headers?: Record<string, string>; protocols?: string[] }) =>
      new WebSocket(url, options?.protocols, {
        headers: options?.headers,
        ...(target.socketPath === undefined ? {} : { socketPath: target.socketPath }),
      }) as unknown as SocketLike,
  }) as PaseoClient
}
