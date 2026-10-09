import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { chmod, link, lstat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sendPiMessage, type PiSender } from './pi-send.js'
import { CUSTOM_TYPE, FRAME_WAIT_MS, MAX_CONNECTIONS, MAX_TEXT_BYTES, VERSION,
  endpointValid, frame, identity, readFrame, record, waitValid } from './pi-protocol.js'

export { sendPiMessage } from './pi-send.js'
export type { PiMessage, PiSender, PiSendOptions } from './pi-send.js'

interface PiContext { sessionManager: { getSessionId(): string } }
export interface PiReceiverAPI extends PiSender {
  on(event: 'session_start', handler: (event: unknown, ctx: PiContext) => Promise<void>): unknown
  on(event: 'session_shutdown', handler: () => Promise<void>): unknown
  on(event: 'message_end', handler: (event: { message: unknown }, ctx: PiContext) => void): unknown
}
export interface PiReceiverOptions { readonly endpoint?: string }

interface Waiter {
  readonly text: string
  finish(state: 'observed' | 'unknown', code?: string): void
}
interface Live {
  readonly sessionId: string
  readonly endpoint: string
  readonly manager: PiContext['sessionManager']
  readonly sockets: Set<Socket>
  readonly waiters: Map<string, Waiter>
  retired: boolean
  server?: Server
  published?: { dev: number; ino: number }
}

/**
 * Resources start only on session_start. Missing endpoint leaves the extension inert.
 * SDK hosts that dispose without session_shutdown must explicitly close this receiver.
 */
export function createPiReceiver(pi: PiReceiverAPI, options: PiReceiverOptions = {}): { close(): Promise<void> } {
  let live: Live | undefined
  let lifecycle = Promise.resolve()
  const serialize = (work: () => Promise<void>) => {
    const result = lifecycle.then(work)
    lifecycle = result.catch(() => {})
    return result
  }
  const retire = () => {
    const old = live
    live = undefined
    if (old !== undefined) {
      old.retired = true
      for (const waiter of [...old.waiters.values()]) waiter.finish('unknown', 'session_replaced')
      for (const socket of old.sockets) socket.destroy()
    }
    return old
  }
  const stop = async (old: Live | undefined) => {
    if (old === undefined) return
    if (old.published !== undefined) {
      const own = old.published
      old.published = undefined
      const current = await lstat(old.endpoint).catch(() => undefined)
      if (current?.isSocket() && current.dev === own.dev && current.ino === own.ino) await unlink(old.endpoint)
    }
    // Bind under an owned temporary name: Node blindly unlinks its bind path on close.
    // Publishing a hard link lets us protect a replacement at the caller's explicit endpoint.
    if (old.server?.listening) await new Promise<void>((resolve) => old.server!.close(() => resolve()))
  }
  const close = () => {
    const old = retire()
    return serialize(() => stop(old))
  }

  pi.on('session_start', async (_event, ctx) => {
    // Getter is deliberately read here, after Pi applies extension flag values.
    const endpoint = options.endpoint
    const sessionId = ctx.sessionManager.getSessionId()
    if (live !== undefined && !live.retired && live.sessionId === sessionId &&
      live.endpoint === endpoint && live.manager === ctx.sessionManager) return lifecycle
    const old = retire()
    const state: Live | undefined = endpoint === undefined ? undefined : {
      sessionId, endpoint, manager: ctx.sessionManager, sockets: new Set(), waiters: new Map(), retired: false,
    }
    live = state
    return serialize(async () => {
      await stop(old)
      if (state === undefined || state.retired) return
      try {
        if (process.platform !== 'darwin') throw new Error('Pi delivery requires macOS.')
        if (!endpointValid(state.endpoint) || !identity(state.sessionId)) throw new Error('Invalid Pi receiver coordinate.')
        const parent = await lstat(dirname(state.endpoint))
        if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
          throw new Error('Pi delivery requires a private caller-owned parent directory.')
        }
        // Fail closed even for stale sockets/files. No reclaim or broad chmod.
        try { await lstat(state.endpoint); throw new Error('Pi delivery endpoint is occupied.') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (state.retired) return
        const bindPath = join(dirname(state.endpoint), `.pi-${randomBytes(6).toString('hex')}`)
        if (!endpointValid(bindPath)) throw new Error('Invalid Pi receiver coordinate.')
        const server = createServer((socket) => accept(state, socket))
        state.server = server
        // All diagnostics are fixed text: no path, request, or native error cause.
        server.on('error', () => { if (live === state) void close() })
        await new Promise<void>((resolve, reject) => {
          server.once('error', () => reject(new Error('Pi delivery listener unavailable.')))
          server.listen(bindPath, resolve)
        })
        if (state.retired) { await stop(state); return }
        await chmod(bindPath, 0o600)
        const owned = await lstat(bindPath)
        await link(bindPath, state.endpoint) // Atomic no-replace publish; even a race fails closed.
        state.published = { dev: owned.dev, ino: owned.ino }
        if (state.retired) await stop(state)
      } catch {
        if (live === state) retire()
        await stop(state)
        throw new Error('Pi delivery listener unavailable.')
      }
    })
  })

  function accept(state: Live, socket: Socket) {
    if (state.retired || state.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    state.sockets.add(socket)
    socket.on('error', () => {})
    let waiter: Waiter | undefined
    let timer = setTimeout(() => socket.destroy(), FRAME_WAIT_MS)
    const reply = (value: unknown) => {
      if (!socket.destroyed) socket.end(frame(value))
      // A non-reading peer must not retain the connection after an attempted reply.
      clearTimeout(timer)
      timer = setTimeout(() => socket.destroy(), FRAME_WAIT_MS)
    }
    const reject = (code: string) => reply({ protocol: VERSION, state: 'rejected', code })
    const detach = readFrame(socket, (request) => {
      clearTimeout(timer)
      if (!record(request) || request.protocol !== VERSION || request.harness !== 'pi') {
        reject('invalid_request'); return
      }
      if (state.retired || live !== state || request.sessionId !== state.sessionId) {
        reject('wrong_session'); return
      }
      if (request.op === 'hello') {
        reply({ protocol: VERSION, harness: 'pi', sessionId: state.sessionId }); return
      }
      if (request.op !== 'send' || typeof request.text !== 'string' || request.text.length === 0 ||
        Buffer.byteLength(request.text) > MAX_TEXT_BYTES || !identity(request.inputId) ||
        (request.delivery !== 'steer' && request.delivery !== 'queue') || !waitValid(request.timeoutMs) ||
        Object.keys(request).some((key) => !['protocol', 'harness', 'op', 'sessionId', 'text', 'inputId', 'delivery', 'timeoutMs'].includes(key))) {
        reject('invalid_request'); return
      }
      const { inputId, text, delivery, timeoutMs } = request
      if (state.waiters.has(inputId)) { reject('duplicate_inflight_id'); return }
      let settled = false
      waiter = {
        text,
        finish(result, code) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          state.waiters.delete(inputId)
          reply({ protocol: VERSION, harness: 'pi', sessionId: state.sessionId, inputId, delivery,
            state: result, ...(result === 'observed' ? { evidence: 'message_end' } : { code }) })
        },
      }
      // Register first: native events may be synchronous in an embedding.
      state.waiters.set(inputId, waiter)
      timer = setTimeout(() => waiter?.finish('unknown', 'timeout'), timeoutMs)
      try {
        sendPiMessage(pi, { customType: CUSTOM_TYPE, content: text, display: true,
          details: { agentDelivery: { deliveryId: inputId } } },
        { deliverAs: delivery === 'queue' ? 'followUp' : 'steer', triggerTurn: true })
      } catch { waiter.finish('unknown', 'native_call') }
    }, () => socket.destroy())
    socket.once('close', () => {
      detach()
      waiter?.finish('unknown', 'transport')
      clearTimeout(timer)
      state.sockets.delete(socket)
    })
  }

  pi.on('message_end', (event, ctx) => {
    const state = live
    const message = event.message
    if (state === undefined || state.retired || ctx.sessionManager !== state.manager ||
      ctx.sessionManager.getSessionId() !== state.sessionId || !record(message) ||
      message.role !== 'custom' || message.customType !== CUSTOM_TYPE || !record(message.details) ||
      !record(message.details.agentDelivery)) return
    const id = message.details.agentDelivery.deliveryId
    if (typeof id !== 'string') return
    const waiter = state.waiters.get(id)
    if (waiter !== undefined && message.content === waiter.text) waiter.finish('observed')
  })
  pi.on('session_shutdown', close)
  return { close }
}
