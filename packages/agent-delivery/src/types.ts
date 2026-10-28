import type { CodexBoundaryStore } from './codex-boundary.js'

declare const targetBrand: unique symbol

export interface OpenCodeTarget { readonly harness: 'opencode'; readonly sessionId: string; readonly [targetBrand]: true }
export interface ClaudeTarget { readonly harness: 'claude'; readonly sessionId: string; readonly [targetBrand]: true }
export interface PiTarget { readonly harness: 'pi'; readonly sessionId: string; readonly [targetBrand]: true }
export interface PaseoTarget { readonly harness: 'paseo'; readonly agentId: string; readonly [targetBrand]: true }
export interface CodexTarget { readonly harness: 'codex'; readonly sessionId: string; readonly [targetBrand]: true }
export type Target = OpenCodeTarget | ClaudeTarget | PiTarget | PaseoTarget | CodexTarget
export type Delivery = 'steer' | 'queue'

export interface OpenCodeSendTextOptions { readonly delivery?: Delivery; readonly inputId?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface ClaudeSendTextOptions { readonly delivery?: 'steer'; readonly inputId?: never; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface PiSendTextOptions { readonly delivery?: Delivery; readonly inputId?: never; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface PaseoSendTextOptions { readonly delivery?: 'steer'; readonly inputId?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface CodexSendTextOptions { readonly delivery?: Delivery; readonly inputId?: never; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export type SendTextOptions = OpenCodeSendTextOptions | ClaudeSendTextOptions | PiSendTextOptions | PaseoSendTextOptions | CodexSendTextOptions

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

/** Connect only to an existing app-server; never starts a service or resumes a thread. */
export interface CodexAppServerConnectOptions {
  readonly harness: 'codex'
  readonly transport?: 'app-server'
  readonly sessionId: string
  readonly endpoint?: string
  readonly token?: string
  readonly codexHome?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Bind CLI coordinates and the same lifecycle source used by the receiver's hooks. */
export interface CodexCliConnectOptions {
  readonly harness: 'codex'
  readonly transport: 'cli'
  readonly sessionId: string
  readonly boundaries: Pick<CodexBoundaryStore, 'queueEligible'>
  readonly codexHome?: string
  readonly endpoint?: string
  readonly bin?: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export type CodexConnectOptions = CodexAppServerConnectOptions | CodexCliConnectOptions

interface OpenCodeAttempt { readonly harness: 'opencode'; readonly sessionId: string; readonly inputId: string }
export type OpenCodeDeliveryResult =
  | (OpenCodeAttempt & { readonly state: 'accepted'; readonly inboxId: string; readonly delivery: Delivery })
  | (OpenCodeAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' })
  | (OpenCodeAttempt & { readonly state: 'rejected'; readonly code: 'http_rejection'; readonly status: number })
  | (OpenCodeAttempt & { readonly state: 'unavailable'; readonly code: 'aborted' | 'timeout' })
interface ClaudeAttempt { readonly harness: 'claude'; readonly sessionId: string }
export type ClaudeDeliveryResult =
  | (ClaudeAttempt & { readonly state: 'written'; readonly messageId: string })
  | (ClaudeAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' })
  | (ClaudeAttempt & { readonly state: 'unavailable'; readonly code: 'aborted' | 'timeout' | 'endpoint_unavailable' | 'authentication_failed' })
interface PiAttempt { readonly harness: 'pi'; readonly sessionId: string; readonly inputId: string }
export type PiDeliveryResult =
  | (PiAttempt & { readonly state: 'observed'; readonly evidence: 'message_end'; readonly delivery: Delivery })
  | (PiAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' | 'session_replaced' | 'native_call' })
  | (PiAttempt & { readonly state: 'rejected'; readonly code: 'wrong_session' | 'invalid_request' | 'duplicate_inflight_id' })
  | (PiAttempt & { readonly state: 'unavailable'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' })
interface PaseoAttempt { readonly harness: 'paseo'; readonly agentId: string; readonly inputId: string }
export type PaseoDeliveryResult =
  | (PaseoAttempt & { readonly state: 'admitted' })
  | (PaseoAttempt & { readonly state: 'rejected'; readonly code: 'key_conflict' | 'not_found' | 'refused' })
  | (PaseoAttempt & { readonly state: 'unavailable'; readonly code: 'aborted' | 'timeout' | 'authentication_failed' | 'transport' })
  | (PaseoAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' })
interface CodexAttempt { readonly harness: 'codex'; readonly sessionId: string; readonly inputId: string }
export type CodexDeliveryResult =
  | (CodexAttempt & { readonly state: 'admitted' })
  | (CodexAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' })
  | (CodexAttempt & { readonly state: 'unavailable'; readonly code: 'timeout' | 'aborted' | 'transport' | 'authentication_failed' })
  | (CodexAttempt & { readonly state: 'rejected'; readonly code: 'not_found' | 'refused' | 'unsupported_version' })
export type DeliveryResult = OpenCodeDeliveryResult | ClaudeDeliveryResult | PiDeliveryResult | PaseoDeliveryResult | CodexDeliveryResult
