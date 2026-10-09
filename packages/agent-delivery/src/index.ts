import { ConnectionError } from './errors.js'
import type { OpenCodeConnectExistingOptions } from './opencode.js'
import type { ClaudeConnectExistingOptions } from './claude.js'
import type { PiConnectExistingOptions } from './pi-client.js'
import type {
  Target, OpenCodeTarget, ClaudeTarget, PiTarget,
  OpenCodeSendTextOptions, ClaudeSendTextOptions, PiSendTextOptions,
  SendTextOptions, DeliveryResult, OpenCodeDeliveryResult, ClaudeDeliveryResult, PiDeliveryResult,
} from './types.js'

export type ConnectExistingOptions = OpenCodeConnectExistingOptions | ClaudeConnectExistingOptions | PiConnectExistingOptions

export function connectExisting(options: OpenCodeConnectExistingOptions): Promise<OpenCodeTarget>
export function connectExisting(options: ClaudeConnectExistingOptions): Promise<ClaudeTarget>
export function connectExisting(options: PiConnectExistingOptions): Promise<PiTarget>
export async function connectExisting(options: ConnectExistingOptions): Promise<Target> {
  if (options?.harness === 'opencode') return (await import('./opencode.js')).connectExisting(options)
  if (options?.harness === 'claude') return (await import('./claude.js')).connectExisting(options)
  if (options?.harness === 'pi') return (await import('./pi-client.js')).connectPi(options)
  throw new ConnectionError('invalid_arguments')
}

export function sendText(target: OpenCodeTarget, text: string, options?: OpenCodeSendTextOptions): Promise<OpenCodeDeliveryResult>
export function sendText(target: ClaudeTarget, text: string, options?: ClaudeSendTextOptions): Promise<ClaudeDeliveryResult>
export function sendText(target: PiTarget, text: string, options?: PiSendTextOptions): Promise<PiDeliveryResult>
export async function sendText(target: Target, text: string, options?: SendTextOptions): Promise<DeliveryResult> {
  if (target?.harness === 'opencode') return (await import('./opencode.js')).sendText(target, text, options)
  if (target?.harness === 'claude') return (await import('./claude.js')).sendText(target, text, options as ClaudeSendTextOptions)
  if (target?.harness === 'pi') return (await import('./pi-client.js')).sendPiText(target, text, options as PiSendTextOptions)
  throw new TypeError('Invalid sendText arguments.')
}

export { ConnectionError }
export type { ConnectionErrorCode } from './errors.js'
export type { OpenCodeConnectExistingOptions } from './opencode.js'
export type { ClaudeConnectExistingOptions } from './claude.js'
export type { PiConnectExistingOptions } from './pi-client.js'
export type {
  Target, OpenCodeTarget, ClaudeTarget, PiTarget, Delivery, SendTextOptions,
  OpenCodeSendTextOptions, ClaudeSendTextOptions, PiSendTextOptions, DeliveryResult,
  OpenCodeDeliveryResult, ClaudeDeliveryResult, PiDeliveryResult,
} from './types.js'
