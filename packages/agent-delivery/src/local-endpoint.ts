import net from 'node:net'
import { resolve } from 'node:path'

export interface LocalEndpoint { readonly path: string }

/** An absolute Unix socket path; connecting is the existence check. */
export function parseLocalEndpoint(raw: unknown): LocalEndpoint {
  if (typeof raw !== 'string' || raw.includes('\0') || !raw.startsWith('/')) throw new Error('Invalid local endpoint.')
  const limit = process.platform === 'darwin' ? 103 : process.platform === 'linux' ? 107 : undefined
  if (limit !== undefined && Buffer.byteLength(raw) > limit) throw new Error('Invalid local endpoint.')
  return { path: resolve(raw) }
}

export class LocalEndpointError extends Error {
  readonly code: 'unavailable' | 'aborted' | 'timeout' | 'transport'

  constructor(code: LocalEndpointError['code']) {
    super(code)
    this.name = 'LocalEndpointError'
    this.code = code
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
