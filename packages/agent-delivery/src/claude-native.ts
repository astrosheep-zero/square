import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { isAbsolute } from 'node:path'

/** Plain native coordinate; no Square facts, credentials or claimed authority. */
export interface ClaudeNativeTarget {
  readonly sessionId: string
  readonly endpoint: string
}
export interface ClaudeNativeControl {
  readonly deadline: number
  readonly signal?: AbortSignal
}
export type NativeWriteResult =
  | { readonly outcome: 'written'; readonly message?: never }
  | { readonly outcome: 'unknown'; readonly code: 'aborted' | 'timeout' | 'transport'; readonly message: string }
  | { readonly outcome: 'unavailable'; readonly code: 'aborted' | 'timeout' | 'endpoint_unavailable' | 'invalid_arguments'; readonly message: string }

/** Submit once. Written means local bytes only, never native admission or consumption. */
export async function writeClaudeNative(target: ClaudeNativeTarget, text: string, control: ClaudeNativeControl): Promise<NativeWriteResult> {
  const remaining = control?.deadline - Date.now()
  if (!target || typeof target.sessionId !== 'string' || !target.sessionId.trim() ||
    typeof target.endpoint !== 'string' || !isAbsolute(target.endpoint) || target.endpoint.includes('\0') ||
    typeof text !== 'string' || !text.length || !control ||
    !Number.isFinite(control.deadline) || control.deadline <= 0 || remaining > 2_147_483_647 ||
    (control.signal !== undefined && !(control.signal instanceof AbortSignal))) {
    return { outcome: 'unavailable', code: 'invalid_arguments', message: 'Invalid native inbox arguments.' }
  }
  if (control.signal?.aborted) return { outcome: 'unavailable', code: 'aborted', message: 'Native inbox write aborted.' }
  if (remaining <= 0) return { outcome: 'unavailable', code: 'timeout', message: 'Native inbox write deadline elapsed.' }
  const frame = `${JSON.stringify({ msgV: 1, msg_id: randomUUID(), type: 'user', session_id: target.sessionId, message: { role: 'user', content: text }, priority: 'next' })}\n`
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let connected = false
    let settled = false
    const finish = (result: NativeWriteResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      control.signal?.removeEventListener('abort', aborted)
      socket.removeListener('connect', connectedSocket)
      // Retain error/close handlers until destruction closes the socket: an already
      // scheduled I/O error must not become an unhandled event after settling.
      socket.destroy()
      resolve(result)
    }
    const stopped = (code: 'aborted' | 'timeout') => finish({
      outcome: connected ? 'unknown' : 'unavailable', code,
      message: code === 'aborted' ? 'Native inbox write aborted.' : 'Native inbox write deadline elapsed.',
    })
    const aborted = () => stopped('aborted')
    const failed = () => finish(connected
      ? { outcome: 'unknown', code: 'transport', message: 'Native inbox write unconfirmed.' }
      : { outcome: 'unavailable', code: 'endpoint_unavailable', message: 'Native inbox endpoint unavailable.' })
    const closed = () => {
      failed()
      socket.removeListener('error', failed)
      socket.removeListener('close', closed)
      socket.removeListener('connect', connectedSocket)
    }
    const connectedSocket = () => {
      connected = true
      if (control.signal?.aborted) { aborted(); return }
      if (control.deadline <= Date.now()) { stopped('timeout'); return }
      socket.end(frame, 'utf8', (error?: Error | null) => {
        if (error) failed()
        else finish({ outcome: 'written' })
      })
    }
    const timer = setTimeout(() => stopped('timeout'), Math.max(1, control.deadline - Date.now()))
    control.signal?.addEventListener('abort', aborted, { once: true })
    socket.once('connect', connectedSocket)
    socket.once('error', failed)
    socket.once('close', closed)
    if (control.signal?.aborted) { aborted(); return }
    if (control.deadline <= Date.now()) { stopped('timeout'); return }
    try { socket.connect(target.endpoint) } catch { failed() }
  })
}
