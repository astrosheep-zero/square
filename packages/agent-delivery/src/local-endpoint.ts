import net from 'node:net'
import { resolve } from 'node:path'

/** Claude's own pipe spelling: `\\.\pipe\<lowercased name>`. */
const PIPE = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i

export interface LocalEndpoint {
  readonly kind: 'unix' | 'pipe'
  /** What the socket connects to. */
  readonly path: string
  /** What the native receiver fingerprints; also the auth key file digest input. */
  readonly canonical: string
}

/**
 * A local endpoint is either a Windows named pipe or an absolute Unix socket
 * path. There is no `stat().isSocket()` check: connecting is the existence check.
 */
export function parseLocalEndpoint(raw: unknown): LocalEndpoint {
  if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('Invalid local endpoint.')
  const pipe = PIPE.exec(raw)
  if (pipe) {
    const canonical = `\\\\.\\pipe\\${pipe[2]!.toLowerCase()}`
    return { kind: 'pipe', path: canonical, canonical }
  }
  if (!(process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(raw) : raw.startsWith('/'))) throw new Error('Invalid local endpoint.')
  const limit = process.platform === 'darwin' ? 103 : process.platform === 'linux' ? 107 : undefined
  if (limit !== undefined && Buffer.byteLength(raw) > limit) throw new Error('Invalid local endpoint.')
  const canonical = resolve(raw)
  return { kind: 'unix', path: canonical, canonical }
}

export class LocalEndpointError extends Error {
  readonly code: 'unavailable' | 'aborted' | 'timeout' | 'transport'
  readonly maybeDelivered: boolean

  constructor(code: LocalEndpointError['code'], maybeDelivered = false) {
    super(code)
    this.name = 'LocalEndpointError'
    this.code = code
    this.maybeDelivered = maybeDelivered
  }
}

function errnoCode(error: unknown): LocalEndpointError['code'] {
  let code: string | undefined
  if (typeof error === 'object' && error !== null) code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'EBUSY' || code === 'EACCES') return 'unavailable'
  return 'transport'
}

export interface LocalConnectScope {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Connect with bounded waiting. A connect failure is `unavailable`: nothing was written. */
export function connectLocal(endpoint: LocalEndpoint, scope: LocalConnectScope = {}): Promise<net.Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new net.Socket()
    let settled = false
    const timeout = scope.timeoutMs === undefined ? undefined : setTimeout(() => finish(new LocalEndpointError('timeout')), scope.timeoutMs)
    // Error/close handlers stay attached past settling: an already scheduled I/O
    // failure must not become an unhandled event once this promise is done.
    const finish = (error?: LocalEndpointError) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      scope.signal?.removeEventListener('abort', aborted)
      socket.removeListener('connect', connected)
      if (error) { socket.destroy(); reject(error) } else resolveSocket(socket)
    }
    const aborted = () => finish(new LocalEndpointError('aborted'))
    const connected = () => finish()
    const failed = (error: Error) => finish(new LocalEndpointError(errnoCode(error)))
    socket.once('connect', connected)
    socket.once('error', failed)
    socket.once('close', () => { if (!settled) finish(new LocalEndpointError('unavailable')) })
    scope.signal?.addEventListener('abort', aborted, { once: true })
    if (scope.signal?.aborted) { aborted(); return }
    try { socket.connect(endpoint.path) } catch (error) { failed(error as Error) }
  })
}

/** LF-delimited JSON frames. Any failure here is past the uncertainty boundary. */
export function writeFrames(socket: net.Socket, frames: object[]): Promise<void> {
  const payload = frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n'
  return new Promise((resolveWrite, reject) => {
    let settled = false
    // Error/close handlers stay attached past settling, so a later I/O failure is
    // swallowed here instead of surfacing as an unhandled socket event.
    const finish = (error?: LocalEndpointError) => {
      if (settled) return
      settled = true
      if (error) { reject(error); return }
      resolveWrite()
    }
    const failed = (error: Error) => finish(new LocalEndpointError(errnoCode(error), true))
    socket.once('error', failed)
    socket.once('close', () => finish(new LocalEndpointError('transport', true)))
    socket.end(payload, 'utf8', (error?: Error | null) => {
      if (error) { failed(error); return }
      finish()
    })
  })
}
