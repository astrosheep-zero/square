import { ConnectionError, DeliveryError, type DeliveryErrorCode } from './errors.js'
import type { OpenCodeConnectExistingOptions } from './opencode.js'
import type { ClaudeConnectExistingOptions } from './claude.js'
import type { PiConnectExistingOptions } from './pi-client.js'
import type { OpenCodeTarget, ClaudeTarget, PiTarget } from './types.js'

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
export type OpenCodeAgent = Steerable<KeyedSendOptions> & Queueable<KeyedSendOptions> & { readonly harness: 'opencode'; readonly sessionId: string }
export type ClaudeAgent = Steerable & { readonly harness: 'claude'; readonly sessionId: string }
export type PiAgent = Steerable & Queueable & { readonly harness: 'pi'; readonly sessionId: string }
export type Agent = OpenCodeAgent | ClaudeAgent | PiAgent

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const codes: Record<string, DeliveryErrorCode> = {
  invalid_arguments: 'invalid_arguments', unsupported_platform: 'unsupported_platform',
  service_unavailable: 'unavailable', authentication_failed: 'authentication_failed',
  session_not_found: 'session_not_found', http_rejection: 'rejected',
  unsupported_version: 'unsupported_version', invalid_response: 'invalid_response',
  timeout: 'timeout', aborted: 'aborted', transport: 'transport',
}
const codeOf = (code: string): DeliveryErrorCode => codes[code] ?? 'transport'

/** Connect writes nothing, so every connect failure is known not delivered. */
function connectFailure(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error
  if (error instanceof ConnectionError) return new DeliveryError(codeOf(error.code), false, undefined, error.status)
  return new DeliveryError(error instanceof TypeError ? 'invalid_arguments' : 'transport', false)
}

/** Past the send precondition, an unclassified failure may have reached the receiver. */
function sendFailure(error: unknown, id?: string): DeliveryError {
  if (error instanceof DeliveryError) return error
  if (error instanceof ConnectionError) return new DeliveryError(codeOf(error.code), false, id, error.status)
  return new DeliveryError(error instanceof TypeError ? 'invalid_arguments' : 'transport', !(error instanceof TypeError), id)
}

interface Attempt { readonly state: string; readonly code?: string; readonly status?: number; readonly inputId?: string }

function attemptFailure(result: Attempt, id?: string): never {
  const code: DeliveryErrorCode = result.state === 'unavailable'
    ? result.code === 'aborted' ? 'aborted' : result.code === 'timeout' ? 'timeout'
      : result.code === 'authentication_failed' ? 'authentication_failed' : 'unavailable'
    : result.state === 'rejected' ? 'rejected'
      : codeOf(result.code ?? 'transport')
  throw new DeliveryError(code, result.state === 'unknown', id ?? result.inputId, result.status)
}

function sendOptions(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new DeliveryError('invalid_arguments')
  return value
}

async function openCode(options: OpenCodeConnectOptions): Promise<OpenCodeAgent> {
  const { connectExisting, sendText } = await import('./opencode.js')
  let target: OpenCodeTarget
  try { target = await connectExisting(options as OpenCodeConnectExistingOptions) }
  catch (error) { throw connectFailure(error) }
  const send = async (text: string, value: unknown, delivery: 'steer' | 'queue'): Promise<Receipt> => {
    const options = sendOptions(value)
    // An unusable caller id is an argument precondition; the native sender rejects it.
    const id = options.id as string | undefined
    try {
      const result = await sendText(target, text, { delivery, inputId: id,
        timeoutMs: options.timeoutMs as number | undefined, signal: options.signal as AbortSignal | undefined })
      if (result.state !== 'accepted') attemptFailure(result, id)
      return { id: result.inputId, proof: 'admitted' }
    } catch (error) { throw sendFailure(error, id) }
  }
  return Object.freeze({ harness: 'opencode' as const, sessionId: target.sessionId,
    steer: (text: string, value?: KeyedSendOptions) => send(text, value, 'steer'),
    queue: (text: string, value?: KeyedSendOptions) => send(text, value, 'queue') })
}

async function claude(options: ClaudeConnectOptions): Promise<ClaudeAgent> {
  const { connectExisting, sendText } = await import('./claude.js')
  let target: ClaudeTarget
  try { target = await connectExisting(options as ClaudeConnectExistingOptions) }
  catch (error) { throw connectFailure(error) }
  const steer = async (text: string, value?: SendOptions): Promise<Receipt> => {
    const options = sendOptions(value)
    try {
      const result = await sendText(target, text, { delivery: 'steer',
        timeoutMs: options.timeoutMs as number | undefined, signal: options.signal as AbortSignal | undefined })
      if (result.state !== 'written') attemptFailure(result)
      return { id: result.messageId, proof: 'written' }
    } catch (error) { throw sendFailure(error) }
  }
  return Object.freeze({ harness: 'claude' as const, sessionId: target.sessionId, steer })
}

async function pi(options: PiConnectOptions): Promise<PiAgent> {
  const { connectPi, sendPiText } = await import('./pi-client.js')
  let target: PiTarget
  try { target = await connectPi(options as PiConnectExistingOptions) }
  catch (error) { throw connectFailure(error) }
  const send = async (text: string, value: unknown, delivery: 'steer' | 'queue'): Promise<Receipt> => {
    const options = sendOptions(value)
    try {
      const result = await sendPiText(target, text, { delivery,
        timeoutMs: options.timeoutMs as number | undefined, signal: options.signal as AbortSignal | undefined })
      if (result.state !== 'observed') attemptFailure(result)
      return { id: result.inputId, proof: 'observed' }
    } catch (error) { throw sendFailure(error) }
  }
  return Object.freeze({ harness: 'pi' as const, sessionId: target.sessionId,
    steer: (text: string, value?: SendOptions) => send(text, value, 'steer'),
    queue: (text: string, value?: SendOptions) => send(text, value, 'queue') })
}

export function connect(options: OpenCodeConnectOptions): Promise<OpenCodeAgent>
export function connect(options: ClaudeConnectOptions): Promise<ClaudeAgent>
export function connect(options: PiConnectOptions): Promise<PiAgent>
export async function connect(options: OpenCodeConnectOptions | ClaudeConnectOptions | PiConnectOptions): Promise<Agent> {
  if (isRecord(options) && options.harness === 'opencode') return openCode(options as OpenCodeConnectOptions)
  if (isRecord(options) && options.harness === 'claude') return claude(options as ClaudeConnectOptions)
  if (isRecord(options) && options.harness === 'pi') return pi(options as PiConnectOptions)
  throw new DeliveryError('invalid_arguments')
}

export { DeliveryError }
export type { DeliveryErrorCode } from './errors.js'
