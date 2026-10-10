declare const targetBrand: unique symbol

export interface OpenCodeTarget { readonly harness: 'opencode'; readonly sessionId: string; readonly [targetBrand]: true }
export interface ClaudeTarget { readonly harness: 'claude'; readonly sessionId: string; readonly [targetBrand]: true }
export interface PiTarget { readonly harness: 'pi'; readonly sessionId: string; readonly [targetBrand]: true }
export interface PaseoTarget { readonly harness: 'paseo'; readonly agentId: string; readonly [targetBrand]: true }
export type Target = OpenCodeTarget | ClaudeTarget | PiTarget | PaseoTarget
export type Delivery = 'steer' | 'queue'

export interface OpenCodeSendTextOptions { readonly delivery?: Delivery; readonly inputId?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface ClaudeSendTextOptions { readonly delivery?: 'steer'; readonly inputId?: never; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface PiSendTextOptions { readonly delivery?: Delivery; readonly inputId?: never; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface PaseoSendTextOptions { readonly delivery?: 'steer'; readonly inputId?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export type SendTextOptions = OpenCodeSendTextOptions | ClaudeSendTextOptions | PiSendTextOptions | PaseoSendTextOptions

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
export type DeliveryResult = OpenCodeDeliveryResult | ClaudeDeliveryResult | PiDeliveryResult | PaseoDeliveryResult
