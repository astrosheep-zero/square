import { randomUUID } from 'node:crypto'
import { connect as connectSocket } from 'node:net'
import { codexQueueEndpoint } from './codex-endpoint.js'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type WebSocket from 'ws'
import { deadline, validSignal, validTimeout } from './deadline.js'
import { ConnectionError } from './errors.js'
import { isIdentity, isRecord } from './guards.js'
import type { CodexAppServerConnectOptions, CodexDeliveryResult, CodexSendTextOptions, CodexTarget } from './types.js'

interface Connection {
  readonly url: string
  readonly socketPath?: string
  readonly token?: string
}

type Scope = ReturnType<typeof deadline>
type Refusal = 'not_found' | 'refused' | 'unsupported_version'
class Fault extends Error {
  constructor(readonly code: 'transport' | 'invalid_response' | 'authentication_failed' | Refusal) {
    // Never retain native messages, endpoints, credentials or input in errors.
    super('Codex delivery failed.')
  }
}
const connections = new WeakMap<CodexTarget, Connection>()

function resolveConnection(options: CodexAppServerConnectOptions): Connection {
  let endpoint = options.endpoint
  if (endpoint === undefined) {
    try {
      endpoint = codexQueueEndpoint(options.codexHome === undefined ? process.env : { ...process.env, CODEX_HOME: options.codexHome })
    } catch { throw new ConnectionError('invalid_arguments') }
  }
  const socketPath = endpoint.startsWith('unix://') ? endpoint.slice(7) : endpoint.startsWith('/') ? endpoint : undefined
  if (socketPath !== undefined) {
    if (process.platform === 'win32') throw new ConnectionError('unsupported_platform')
    if (!socketPath.startsWith('/') || socketPath.includes('\0')) throw new ConnectionError('invalid_arguments')
    // The custom connector avoids ws+unix URL escaping/delimiter ambiguities in
    // filesystem paths. This is still an HTTP WebSocket handshake over UDS.
    return { url: 'ws://localhost/', socketPath, token: options.token }
  }
  let url: URL
  try { url = new URL(endpoint) } catch { throw new ConnectionError('invalid_arguments') }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ConnectionError('invalid_arguments')
  }
  return { url: url.href, token: options.token }
}

/** Only documented request refusals prove non-admission. An internal server
 * error may follow a write and must not be turned into a safe-to-retry refusal. */
function rpcError(value: unknown, method: string): Fault {
  if (!isRecord(value) || !Number.isInteger(value.code) || typeof value.message !== 'string') return new Fault('invalid_response')
  if (value.code === -32601) return new Fault('unsupported_version')
  if (value.code === -32600 || value.code === -32602) {
    const message = value.message.replace(/^Invalid request:\s*/i, '')
    const variant = /^unknown variant [`'"]([^`'"]+)[`'"]/i.exec(message)
    if (variant?.[1] === method || /^(?:unknown method\b|method not found\b)/i.test(message)) return new Fault('unsupported_version')
    if (/^(?:thread not found:|thread not loaded:|no rollout found for thread id )/.test(value.message)) return new Fault('not_found')
    return new Fault('refused')
  }
  return new Fault('transport')
}

/** One connection, sequential RPCs, no subscriptions, reconnection or retries. */
class Peer {
  private sequence = 0
  private failure?: Fault
  private pending?: { id: number; method: string; resolve(value: unknown): void; reject(error: Fault): void }
  private readonly opened: Promise<void>
  private readonly closed: Promise<void>
  private rejectOpen!: (error: Fault) => void
  private onOpen!: () => void
  private onClose!: () => void
  private readonly onError = () => this.fail(new Fault('transport'))
  private readonly onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
    this.fail(new Fault(response.statusCode === 401 || response.statusCode === 403 ? 'authentication_failed' : 'transport'))
    response.resume()
    // Installing unexpected-response transfers handshake cleanup to us.
    this.socket.terminate()
  }
  private readonly onMessage = (raw: WebSocket.RawData) => {
    let value: unknown
    try { value = JSON.parse(raw.toString()) } catch { this.fail(new Fault('invalid_response')); return }
    if (!isRecord(value)) { this.fail(new Fault('invalid_response')); return }
    // Server notifications and requests do not acknowledge our mutation. This
    // sender never resumes a thread or takes over its approval/tool requests.
    if (typeof value.method === 'string' && !('result' in value) && !('error' in value)) return
    const pending = this.pending
    if (!pending || value.id !== pending.id || ('result' in value) === ('error' in value)) {
      this.fail(new Fault('invalid_response')); return
    }
    this.pending = undefined
    if ('error' in value) pending.reject(rpcError(value.error, pending.method))
    else pending.resolve(value.result)
  }

  constructor(private readonly socket: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      this.rejectOpen = reject
      this.onOpen = resolve
    })
    this.closed = new Promise((resolve) => {
      this.onClose = () => { this.fail(new Fault('transport')); resolve() }
    })
    // Opening can fail while the caller's deadline is expiring.
    void this.opened.catch(() => {})
    socket.on('open', this.onOpen)
    socket.on('close', this.onClose)
    socket.on('error', this.onError)
    socket.on('unexpected-response', this.onUnexpectedResponse)
    socket.on('message', this.onMessage)
  }

  private fail(error: Fault) {
    this.failure ??= error
    this.rejectOpen(this.failure)
    this.pending?.reject(this.failure)
    this.pending = undefined
  }

  async initialize(scope: Scope) {
    await scope.wait(this.opened)
    const result = await this.call('initialize', {
      clientInfo: { name: 'agent-delivery', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, scope)
    if (!isRecord(result) || !isIdentity(result.userAgent) || !isIdentity(result.codexHome) ||
      !isIdentity(result.platformFamily) || !isIdentity(result.platformOs)) throw new Fault('invalid_response')
    scope.check()
    this.socket.send(JSON.stringify({ method: 'initialized' }))
  }

  call(method: string, params: unknown, scope: Scope, dispatch?: () => void): Promise<unknown> {
    scope.check()
    if (this.failure) throw this.failure
    if (this.socket.readyState !== 1) throw new Fault('transport')
    const id = ++this.sequence
    const body = JSON.stringify({ id, method, params })
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending = { id, method, resolve, reject }
      // From the instant send is attempted the peer may have received bytes;
      // callbacks and timeouts cannot prove otherwise.
      dispatch?.()
      try { this.socket.send(body, (error) => { if (error) this.fail(new Fault('transport')) }) }
      catch { this.fail(new Fault('transport')) }
    })
    return scope.wait(response)
  }

  async close() {
    this.fail(new Fault('transport'))
    // Immediate destruction, not a graceful-close timer that keeps a one-shot
    // caller alive. Keep error handling until close, including failed handshakes.
    this.socket.terminate()
    await this.closed
    this.socket.off('open', this.onOpen)
    this.socket.off('close', this.onClose)
    this.socket.off('error', this.onError)
    this.socket.off('unexpected-response', this.onUnexpectedResponse)
    this.socket.off('message', this.onMessage)
  }
}

async function open(connection: Connection, scope: Scope): Promise<Peer> {
  scope.check()
  const { default: Socket } = await scope.wait(import('ws'))
  scope.check()
  return new Peer(new Socket(connection.url, {
    ...(connection.socketPath === undefined ? {} : { createConnection: () => connectSocket({ path: connection.socketPath! }) }),
    ...(connection.token === undefined ? {} : { headers: { Authorization: `Bearer ${connection.token}` } }),
    followRedirects: false,
    perMessageDeflate: false,
  }))
}

async function readThread(peer: Peer, sessionId: string, scope: Scope, includeTurns = false): Promise<Record<string, unknown>> {
  const value = await peer.call('thread/read', { threadId: sessionId, includeTurns }, scope)
  if (!isRecord(value) || !isRecord(value.thread) || value.thread.id !== sessionId) throw new Fault('invalid_response')
  return value.thread
}

function activeTurn(turns: unknown): string | undefined {
  if (!Array.isArray(turns) || turns.some((turn) => !isRecord(turn) || !isIdentity(turn.id) || typeof turn.status !== 'string' ||
    !['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status))) throw new Fault('invalid_response')
  const active = turns.filter((turn) => turn.status === 'inProgress')
  if (active.length > 1) throw new Fault('invalid_response')
  return active[0]?.id
}

async function discoverTurn(peer: Peer, metadata: Record<string, unknown>, sessionId: string, scope: Scope): Promise<string | undefined> {
  // A new idle thread can have no materialized history at all (0.160.1 returns
  // list_turns-not-supported). Metadata already proves it cannot be steered.
  if (isRecord(metadata.status) && ['idle', 'notLoaded'].includes(metadata.status.type as string)) return undefined
  // Live history includes turns that have not reached paginated storage yet.
  // Always prefer it, irrespective of the thread's historyMode.
  const thread = await readThread(peer, sessionId, scope, true)
  const liveId = activeTurn(thread.turns)
  if (liveId !== undefined || !isRecord(thread.status) || thread.status.type !== 'active') return liveId
  // Only an active thread with no live turn needs the persisted-page fallback.
  // Native ThreadStatus spells an in-progress thread { type: 'active', ... }.
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await peer.call('thread/turns/list', {
      threadId: sessionId, sortDirection: 'desc', itemsView: 'summary', limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    }, scope)
    if (!isRecord(page) || !(page.nextCursor === null || isIdentity(page.nextCursor))) throw new Fault('invalid_response')
    const id = activeTurn(page.data)
    if (id !== undefined) return id
    if (page.nextCursor === null) return undefined
    if (cursors.has(page.nextCursor)) throw new Fault('invalid_response')
    cursor = page.nextCursor
    cursors.add(cursor)
  }
}

/** Address an existing thread on an already running app-server. Never starts a
 * service, resumes a thread, or claims ownership of a standalone CLI session. */
export async function connectCodex(options: CodexAppServerConnectOptions): Promise<CodexTarget> {
  if (!isRecord(options) || options.harness !== 'codex' ||
    (options.transport !== undefined && options.transport !== 'app-server') || !isIdentity(options.sessionId) ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal) ||
    (options.endpoint !== undefined && !isIdentity(options.endpoint)) ||
    (options.codexHome !== undefined && !isIdentity(options.codexHome)) ||
    (options.token !== undefined && (!isIdentity(options.token) || /[\r\n]/.test(options.token)))) {
    throw new ConnectionError('invalid_arguments')
  }
  const connection = resolveConnection(options)
  const scope = deadline(options.timeoutMs, options.signal)
  let peer: Peer | undefined
  try {
    peer = await open(connection, scope)
    await peer.initialize(scope)
    await readThread(peer, options.sessionId, scope)
    const target = Object.freeze({ harness: 'codex' as const, sessionId: options.sessionId }) as CodexTarget
    connections.set(target, connection)
    return target
  } catch (error) {
    if (scope.code !== undefined) throw new ConnectionError(scope.code)
    const code = error instanceof Fault ? error.code : 'transport'
    throw new ConnectionError(code === 'not_found' ? 'session_not_found' : code === 'refused' ? 'rejected' : code)
  } finally {
    scope.close()
    await peer?.close()
  }
}

/** A UUID correlates the native user input; it is not an idempotency key. A
 * successful RPC means admission only, not consumption or model completion. */
export async function sendCodexText(target: CodexTarget, text: string, options: CodexSendTextOptions = {}): Promise<CodexDeliveryResult> {
  const connection = connections.get(target)
  if (connection === undefined || typeof text !== 'string' || text.length === 0 || !isRecord(options) ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal) || options.inputId !== undefined ||
    (options.delivery !== undefined && options.delivery !== 'steer' && options.delivery !== 'queue')) {
    throw new TypeError('Invalid sendText arguments.')
  }
  const inputId = randomUUID()
  const attempt = { harness: 'codex' as const, sessionId: target.sessionId, inputId }
  const scope = deadline(options.timeoutMs, options.signal)
  let peer: Peer | undefined
  let dispatched = false
  try {
    peer = await open(connection, scope)
    await peer.initialize(scope)
    const thread = await readThread(peer, target.sessionId, scope)
    const delivery = options.delivery ?? 'steer'
    const expectedTurnId = delivery === 'steer' ? await discoverTurn(peer, thread, target.sessionId, scope) : undefined
    if (delivery === 'steer' && expectedTurnId === undefined) return { ...attempt, state: 'rejected', code: 'refused' }
    const input = [{ type: 'text', text, text_elements: [] }]
    const result = await peer.call(delivery === 'steer' ? 'turn/steer' : 'thread/queue/add', {
      threadId: target.sessionId, clientUserMessageId: inputId, input,
      ...(delivery === 'steer' ? { expectedTurnId } : {}),
    }, scope, () => { dispatched = true })
    if (!isRecord(result)) throw new Fault('invalid_response')
    if (delivery === 'steer') {
      if (result.turnId !== expectedTurnId) throw new Fault('invalid_response')
    } else {
      const queued = result.queuedSubmission
      if (!isRecord(queued) || !isIdentity(queued.id) || queued.clientUserMessageId !== inputId ||
        !Array.isArray(queued.input) || queued.input.length !== 1 || !isRecord(queued.input[0]) ||
        queued.input[0].type !== 'text' || queued.input[0].text !== text ||
        !Array.isArray(queued.input[0].text_elements) || queued.input[0].text_elements.length !== 0) throw new Fault('invalid_response')
    }
    return { ...attempt, state: 'admitted' }
  } catch (error) {
    const code = scope.code ?? (error instanceof Fault ? error.code : 'transport')
    if (code === 'not_found' || code === 'refused' || code === 'unsupported_version') return { ...attempt, state: 'rejected', code }
    if (dispatched) return { ...attempt, state: 'unknown', code: code === 'authentication_failed' ? 'transport' : code }
    // The public contract has no unavailable/invalid_response variant. A bad
    // setup/read response is a known-unsent transport precondition failure.
    return { ...attempt, state: 'unavailable', code: code === 'invalid_response' ? 'transport' : code }
  } finally {
    scope.close()
    await peer?.close()
  }
}
