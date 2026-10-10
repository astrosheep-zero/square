import { ConnectionError, DeliveryError, type DeliveryErrorCode } from './errors.js'
import { isRecord } from './guards.js'
import type { OpenCodeConnectExistingOptions } from './opencode.js'
import type { ClaudeConnectExistingOptions } from './claude.js'
import type { PiConnectExistingOptions } from './pi-client.js'
import type { PaseoConnectExistingOptions } from './paseo.js'
import type { OpenCodeTarget, ClaudeTarget, PiTarget, PaseoTarget, OpenCodeSendTextOptions, ClaudeSendTextOptions, PiSendTextOptions, PaseoSendTextOptions } from './types.js'

export interface SendOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface KeyedSendOptions extends SendOptions { readonly id?: string }
export interface Receipt { readonly id: string; readonly proof: 'written' | 'admitted' | 'observed' }
export interface Steerable<O = SendOptions> { steer(text: string, options?: O): Promise<Receipt> }
export interface Queueable<O = SendOptions> { queue(text: string, options?: O): Promise<Receipt> }

export interface OpenCodeConnectOptions {
  readonly harness: 'opencode'
  readonly sessionId: string
  readonly endpoint?: { readonly url: string; readonly auth?: { readonly type: 'basic'; readonly username: string; readonly password: string } }
  readonly registrationFile?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface ClaudeConnectOptions {
  readonly harness: 'claude'
  readonly sessionId: string
  readonly endpoint: string
  readonly token?: string
  readonly claudeHome?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface PiConnectOptions {
  readonly harness: 'pi'
  readonly sessionId: string
  readonly endpoint: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface PaseoConnectOptions {
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
export type OpenCodeAgent = Steerable<KeyedSendOptions> & Queueable<KeyedSendOptions> & { readonly harness: 'opencode'; readonly sessionId: string }
export type ClaudeAgent = Steerable & { readonly harness: 'claude'; readonly sessionId: string }
export type PiAgent = Steerable & Queueable & { readonly harness: 'pi'; readonly sessionId: string }
export type PaseoAgent = Steerable<KeyedSendOptions> & { readonly harness: 'paseo'; readonly agentId: string }
export type Agent = OpenCodeAgent | ClaudeAgent | PiAgent | PaseoAgent

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
    : attempt.state === 'rejected' ? attempt.code === 'not_found' ? 'session_not_found' : 'rejected'
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

/** Everything that differs between the four native transports, as data. */
interface Harness {
  readonly harness: 'opencode' | 'claude' | 'pi' | 'paseo'
  readonly proof: Receipt['proof']
  readonly accepted: string
  readonly coordinate: 'sessionId' | 'agentId'
  /** Whether this transport claims a caller's own idempotency id. */
  readonly keyed: boolean
  readonly queue: boolean
  readonly id: (result: NativeSend) => string
  /** Load one native module and address one existing target. */
  readonly open: (options: unknown) => Promise<{
    readonly coordinate: string
    readonly send: (text: string, value: Record<string, unknown>) => Promise<NativeSend>
  }>
}

const harnesses: Record<string, Harness> = {
  opencode: {
    harness: 'opencode', proof: 'admitted', accepted: 'accepted', coordinate: 'sessionId', keyed: true, queue: true,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectExisting, sendText } = await import('./opencode.js')
      const target = await connectExisting(options as OpenCodeConnectExistingOptions)
      return { coordinate: target.sessionId, send: (text, value) => sendText(target, text, value as OpenCodeSendTextOptions) }
    },
  },
  claude: {
    harness: 'claude', proof: 'written', accepted: 'written', coordinate: 'sessionId', keyed: false, queue: false,
    id: (result) => result.messageId!,
    open: async (options) => {
      const { connectExisting, sendText } = await import('./claude.js')
      const target = await connectExisting(options as ClaudeConnectExistingOptions)
      return { coordinate: target.sessionId, send: (text, value) => sendText(target, text, value as ClaudeSendTextOptions) }
    },
  },
  pi: {
    harness: 'pi', proof: 'observed', accepted: 'observed', coordinate: 'sessionId', keyed: false, queue: true,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectPi, sendPiText } = await import('./pi-client.js')
      const target = await connectPi(options as PiConnectExistingOptions)
      return { coordinate: target.sessionId, send: (text, value) => sendPiText(target, text, value as PiSendTextOptions) }
    },
  },
  paseo: {
    harness: 'paseo', proof: 'admitted', accepted: 'admitted', coordinate: 'agentId', keyed: true, queue: false,
    id: (result) => result.inputId!,
    open: async (options) => {
      const { connectPaseo, sendPaseoText } = await import('./paseo.js')
      const target = await connectPaseo(options as PaseoConnectExistingOptions)
      return { coordinate: target.agentId, send: (text, value) => sendPaseoText(target, text, value as PaseoSendTextOptions) }
    },
  },
}

export function connect(options: OpenCodeConnectOptions): Promise<OpenCodeAgent>
export function connect(options: ClaudeConnectOptions): Promise<ClaudeAgent>
export function connect(options: PiConnectOptions): Promise<PiAgent>
export function connect(options: PaseoConnectOptions): Promise<PaseoAgent>
export async function connect(options: OpenCodeConnectOptions | ClaudeConnectOptions | PiConnectOptions | PaseoConnectOptions): Promise<Agent> {
  const harness = isRecord(options) && typeof options.harness === 'string' ? options.harness : undefined
  // An own-key check keeps Object.prototype names out of the transport table.
  const spec = harness !== undefined && Object.hasOwn(harnesses, harness) ? harnesses[harness] : undefined
  if (spec === undefined) throw new DeliveryError('invalid_arguments')
  let opened
  try { opened = await spec.open(options) }
  catch (error) { throw failure(error, 'connect') }
  const send = async (text: string, value: unknown, delivery: 'steer' | 'queue'): Promise<Receipt> => {
    const options = value === undefined ? {} : value
    if (!isRecord(options)) throw new DeliveryError('invalid_arguments')
    // An unusable caller id is an argument precondition; the native sender rejects it.
    const id = options.id as string | undefined
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
    steer: (text: string, value?: SendOptions) => send(text, value, 'steer'),
  }
  if (spec.queue) agent.queue = (text: string, value?: SendOptions) => send(text, value, 'queue')
  return Object.freeze(agent) as unknown as Agent
}

export { DeliveryError }
export type { DeliveryErrorCode } from './errors.js'
