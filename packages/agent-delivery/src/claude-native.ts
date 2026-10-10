import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { deadline } from './deadline.js'
import { connectLocal, LocalEndpointError, parseLocalEndpoint, writeFrames } from './local-endpoint.js'
import { resolveClaudeToken } from './claude-auth.js'

/** Plain native coordinate; no Square facts, credentials or claimed authority. */
export interface ClaudeNativeTarget {
  readonly sessionId: string
  readonly endpoint: string
  readonly token?: string
  readonly claudeHome?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly messageId?: string
}
export interface ClaudeNativeControl {
  readonly deadline: number
  readonly signal?: AbortSignal
}
export type NativeWriteResult =
  | { readonly outcome: 'written'; readonly message?: never }
  | { readonly outcome: 'unknown'; readonly code: 'aborted' | 'timeout' | 'transport'; readonly message: string }
  | { readonly outcome: 'unavailable'; readonly code: 'aborted' | 'timeout' | 'endpoint_unavailable' | 'invalid_arguments' | 'authentication_failed'; readonly message: string }

const detail = (code: string) => code === 'aborted' ? 'Native inbox write aborted.'
  : code === 'timeout' ? 'Native inbox write deadline elapsed.'
    : code === 'authentication_failed' ? 'Claude authentication failed.'
      : 'Native inbox endpoint unavailable.'

/** Submit once. Written means local bytes only, never native admission or consumption. */
export async function writeClaudeNative(target: ClaudeNativeTarget, text: string, control: ClaudeNativeControl): Promise<NativeWriteResult> {
  const remaining = control?.deadline - Date.now()
  let endpoint
  try { endpoint = parseLocalEndpoint(target?.endpoint) } catch {
    return { outcome: 'unavailable', code: 'invalid_arguments', message: 'Invalid native inbox arguments.' }
  }
  if (!target || typeof target.sessionId !== 'string' || !target.sessionId.trim() ||
    typeof text !== 'string' || !text.length || !control ||
    !Number.isFinite(control.deadline) || control.deadline <= 0 || remaining > 2_147_483_647 ||
    (control.signal !== undefined && !(control.signal instanceof AbortSignal))) {
    return { outcome: 'unavailable', code: 'invalid_arguments', message: 'Invalid native inbox arguments.' }
  }
  if (control.signal?.aborted) return { outcome: 'unavailable', code: 'aborted', message: detail('aborted') }
  if (remaining <= 0) return { outcome: 'unavailable', code: 'timeout', message: detail('timeout') }
  let token: string | undefined
  try {
    token = await resolveClaudeToken({ endpoint, token: target.token, claudeHome: target.claudeHome, env: target.env, platform: target.platform })
  } catch {
    return { outcome: 'unavailable', code: 'authentication_failed', message: detail('authentication_failed') }
  }
  const frames = [
    ...(token === undefined ? [] : [{ type: 'auth', token }]),
    { msgV: 1, msg_id: target.messageId ?? randomUUID(), type: 'user', session_id: target.sessionId, message: { role: 'user', content: text }, priority: 'next' },
  ]
  const scope = deadline(Math.min(remaining, 2_147_483_647), control.signal)
  let socket: Socket | undefined
  try {
    scope.check()
    socket = await connectLocal(endpoint, { signal: scope.signal, timeoutMs: Math.max(1, remaining) })
    scope.check()
    // A receiver that never drains must not hold the caller past its deadline.
    await scope.wait(writeFrames(socket, frames))
    scope.check()
    return { outcome: 'written' }
  } catch (error) {
    const local = error instanceof LocalEndpointError ? error : undefined
    const code = scope.code ?? local?.code
    if (code === 'aborted' || code === 'timeout') {
      return { outcome: socket ? 'unknown' : 'unavailable', code, message: detail(code) }
    }
    if (socket) return { outcome: 'unknown', code: 'transport', message: 'Native inbox write unconfirmed.' }
    return { outcome: 'unavailable', code: 'endpoint_unavailable', message: detail('unavailable') }
  } finally {
    socket?.destroy()
    scope.close()
  }
}
