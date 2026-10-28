import { ConnectionError, DeliveryError, type DeliveryErrorCode } from './errors.js'
import { isRecord } from './guards.js'
import type { OpenCodeConnectOptions, ClaudeConnectOptions, PiConnectOptions, PaseoConnectOptions, CodexConnectOptions, CodexAppServerConnectOptions, CodexCliConnectOptions, OpenCodeSendTextOptions, ClaudeSendTextOptions, PiSendTextOptions, PaseoSendTextOptions, CodexSendTextOptions } from './types.js'
export type { OpenCodeConnectOptions, ClaudeConnectOptions, PiConnectOptions, PaseoConnectOptions, CodexConnectOptions, CodexAppServerConnectOptions, CodexCliConnectOptions } from './types.js'

export interface SendOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface KeyedSendOptions extends SendOptions { readonly id?: string }
export interface Receipt { readonly id: string; readonly proof: 'written' | 'admitted' | 'observed' }
export interface Steerable<O = SendOptions> { steer(text: string, options?: O): Promise<Receipt> }
export interface Queueable<O = SendOptions> { queue(text: string, options?: O): Promise<Receipt> }

export type OpenCodeAgent = Steerable<KeyedSendOptions> & Queueable<KeyedSendOptions> & { readonly harness: 'opencode'; readonly sessionId: string }
export type ClaudeAgent = Steerable & { readonly harness: 'claude'; readonly sessionId: string }
export type PiAgent = Steerable & Queueable & { readonly harness: 'pi'; readonly sessionId: string }
export type PaseoAgent = Steerable<KeyedSendOptions> & { readonly harness: 'paseo'; readonly agentId: string }
export type CodexAppServerAgent = Steerable & Queueable & { readonly harness: 'codex'; readonly transport: 'app-server'; readonly sessionId: string }
export type CodexCliAgent = Queueable & { readonly harness: 'codex'; readonly transport: 'cli'; readonly sessionId: string }
export type CodexAgent = CodexAppServerAgent | CodexCliAgent
export type Agent = OpenCodeAgent | ClaudeAgent | PiAgent | PaseoAgent | CodexAgent

const codes: Record<string, DeliveryErrorCode> = {
  invalid_arguments: 'invalid_arguments', unsupported_platform: 'unsupported_platform',
  service_unavailable: 'unavailable', authentication_failed: 'authentication_failed',
  session_not_found: 'session_not_found', http_rejection: 'rejected',
  unsupported_version: 'unsupported_version', invalid_response: 'invalid_response',
  timeout: 'timeout', aborted: 'aborted', transport: 'transport',
}

interface Attempt { readonly state: string; readonly code?: string; readonly status?: number; readonly inputId?: string }

/**
 * One classification path for a connection failure, a send failure and the
 * harness's own attempt state. Past the send precondition an unclassified
 * failure may have reached the receiver.
 */
function failure(error: unknown, phase: 'connect' | 'send', id?: string): DeliveryError {
  if (error instanceof DeliveryError) return error
  if (error instanceof ConnectionError) return new DeliveryError(codes[error.code] ?? 'transport', false, id, error.status)
  if (error instanceof TypeError) return new DeliveryError('invalid_arguments', false, id)
  const attempt = error as Partial<Attempt>
  if (typeof attempt?.state !== 'string') return new DeliveryError('transport', phase === 'send', id)
  const code: DeliveryErrorCode = attempt.state === 'unavailable'
    ? attempt.code === 'aborted' ? 'aborted' : attempt.code === 'timeout' ? 'timeout'
      : attempt.code === 'authentication_failed' ? 'authentication_failed' : 'unavailable'
    : attempt.state === 'rejected' ? attempt.code === 'not_found' ? 'session_not_found'
      : attempt.code === 'unsupported_version' ? 'unsupported_version' : 'rejected'
      : codes[attempt.code ?? 'transport'] ?? 'transport'
  return new DeliveryError(code, attempt.state === 'unknown', id ?? attempt.inputId, attempt.status)
}

interface NativeSend {
  readonly state: string
  readonly code?: string
  readonly status?: number
  readonly inputId?: string
  readonly messageId?: string
}

/** Everything that differs between the native transports, as data. */
interface Harness {
  readonly harness: 'opencode' | 'claude' | 'pi' | 'paseo' | 'codex'
  readonly proof: Receipt['proof']
  readonly accepted: string
  readonly coordinate: 'sessionId' | 'agentId'
  /** Whether this transport claims a caller's own idempotency id. */
  readonly keyed: boolean
  readonly queue: boolean
  readonly steer?: false
  readonly transport?: 'cli' | 'app-server'
  readonly id: (result: NativeSend) => string
  /** Load one native module and address one existing target. */
  readonly open: (options: unknown) => Promise<{
    readonly coordinate: string
    readonly send: (text: string, value: Record<string, unknown>) => Promise<NativeSend>
  }>
}

const harnesses: Record<string, Harness> = {
  'codex-cli': {
    harness: 'codex', transport: 'cli', proof: 'admitted', accepted: 'admitted', coordinate: 'sessionId', keyed: false, queue: true, steer: false,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectCodexCli } = await import('./codex-cli.js')
      const target = await connectCodexCli(options as CodexCliConnectOptions)
      return { coordinate: target.coordinate, send: (text, value) => target.send(text, value as CodexSendTextOptions) }
    },
  },
  codex: {
    harness: 'codex', transport: 'app-server', proof: 'admitted', accepted: 'admitted', coordinate: 'sessionId', keyed: false, queue: true,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectCodex, sendCodexText } = await import('./codex.js')
      const target = await connectCodex(options as CodexAppServerConnectOptions)
      return { coordinate: target.sessionId, send: (text, value) => sendCodexText(target, text, value as CodexSendTextOptions) }
    },
  },
  opencode: {
    harness: 'opencode', proof: 'admitted', accepted: 'accepted', coordinate: 'sessionId', keyed: true, queue: true,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectExisting, sendText } = await import('./opencode.js')
      const target = await connectExisting(options as OpenCodeConnectOptions)
      return { coordinate: target.sessionId, send: (text, value) => sendText(target, text, value as OpenCodeSendTextOptions) }
    },
  },
  claude: {
    harness: 'claude', proof: 'written', accepted: 'written', coordinate: 'sessionId', keyed: false, queue: false,
    id: (result) => result.messageId!,
    open: async (options) => {
      const { connectExisting, sendText } = await import('./claude.js')
      const target = await connectExisting(options as ClaudeConnectOptions)
      return { coordinate: target.sessionId, send: (text, value) => sendText(target, text, value as ClaudeSendTextOptions) }
    },
  },
  pi: {
    harness: 'pi', proof: 'observed', accepted: 'observed', coordinate: 'sessionId', keyed: false, queue: true,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectPi, sendPiText } = await import('./pi-client.js')
      const target = await connectPi(options as PiConnectOptions)
      return { coordinate: target.sessionId, send: (text, value) => sendPiText(target, text, value as PiSendTextOptions) }
    },
  },
  paseo: {
    harness: 'paseo', proof: 'admitted', accepted: 'admitted', coordinate: 'agentId', keyed: true, queue: false,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectPaseo, sendPaseoText } = await import('./paseo.js')
      const target = await connectPaseo(options as PaseoConnectOptions)
      return { coordinate: target.agentId, send: (text, value) => sendPaseoText(target, text, value as PaseoSendTextOptions) }
    },
  },
}

export function connect(options: OpenCodeConnectOptions): Promise<OpenCodeAgent>
export function connect(options: ClaudeConnectOptions): Promise<ClaudeAgent>
export function connect(options: PiConnectOptions): Promise<PiAgent>
export function connect(options: PaseoConnectOptions): Promise<PaseoAgent>
export function connect(options: CodexCliConnectOptions): Promise<CodexCliAgent>
export function connect(options: CodexAppServerConnectOptions): Promise<CodexAppServerAgent>
export function connect(options: CodexConnectOptions): Promise<CodexAgent>
export async function connect(options: OpenCodeConnectOptions | ClaudeConnectOptions | PiConnectOptions | PaseoConnectOptions | CodexConnectOptions): Promise<Agent> {
  const harness = isRecord(options) && typeof options.harness === 'string' ? options.harness : undefined
  // An own-key check keeps Object.prototype names out of the transport table.
  const key = harness === 'codex' && isRecord(options) && options.transport === 'cli' ? 'codex-cli' : harness
  const spec = key !== undefined && Object.hasOwn(harnesses, key) ? harnesses[key] : undefined
  if (spec === undefined || spec.harness !== harness) throw new DeliveryError('invalid_arguments')
  let opened
  try { opened = await spec.open(options) }
  catch (error) { throw failure(error, 'connect') }
  const send = async (text: string, value: unknown, delivery: 'steer' | 'queue'): Promise<Receipt> => {
    const options = value === undefined ? {} : value
    if (!isRecord(options)) throw new DeliveryError('invalid_arguments')
    // An unusable caller id is an argument precondition; the native sender rejects it.
    const id = options.id as string | undefined
    if (!spec.keyed && id !== undefined) throw new DeliveryError('invalid_arguments')
    try {
      const result = await opened.send(text, spec.keyed
        ? { delivery, inputId: id, timeoutMs: options.timeoutMs, signal: options.signal }
        : { delivery, timeoutMs: options.timeoutMs, signal: options.signal })
      if (result.state !== spec.accepted) throw failure(result, 'send', id)
      return { id: spec.id(result), proof: spec.proof }
    } catch (error) { throw failure(error, 'send', id) }
  }
  const agent: Record<string, unknown> = {
    harness: spec.harness,
    [spec.coordinate]: opened.coordinate,
  }
  if (spec.transport) agent.transport = spec.transport
  if (spec.steer !== false) agent.steer = (text: string, value?: SendOptions) => send(text, value, 'steer')
  if (spec.queue) agent.queue = (text: string, value?: SendOptions) => send(text, value, 'queue')
  return Object.freeze(agent) as unknown as Agent
}

export { DeliveryError }
export type { DeliveryErrorCode } from './errors.js'
