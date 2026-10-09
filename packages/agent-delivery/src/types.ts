declare const targetBrand: unique symbol

/** In-memory handles issued by connectExisting, not presence/admission guarantees. */
export interface OpenCodeTarget {
  readonly harness: 'opencode'
  readonly sessionId: string
  readonly [targetBrand]: true
}
export interface ClaudeTarget {
  readonly harness: 'claude'
  readonly sessionId: string
  readonly [targetBrand]: true
}
export interface PiTarget {
  readonly harness: 'pi'
  readonly sessionId: string
  readonly [targetBrand]: true
}
export type Target = OpenCodeTarget | ClaudeTarget | PiTarget

export type Delivery = 'steer' | 'queue'

export interface OpenCodeSendTextOptions {
  readonly delivery?: Delivery
  readonly inputId?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface ClaudeSendTextOptions {
  /** Native next boundary, not interruption of an in-flight request/tool. */
  readonly delivery?: 'steer'
  readonly inputId?: never
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface PiSendTextOptions {
  readonly delivery?: Delivery
  /** Pi creates a fresh attempt ID; no caller idempotency coordinate. */
  readonly inputId?: never
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export type SendTextOptions = OpenCodeSendTextOptions | ClaudeSendTextOptions | PiSendTextOptions

interface OpenCodeAttempt {
  readonly harness: 'opencode'
  readonly sessionId: string
  readonly inputId: string
}

/** Acceptance is durable inbox admission only, not model consumption or display. */
export type OpenCodeDeliveryResult =
  | (OpenCodeAttempt & { readonly state: 'accepted'; readonly inboxId: string; readonly delivery: Delivery })
  | (OpenCodeAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' })
  | (OpenCodeAttempt & { readonly state: 'rejected'; readonly code: 'http_rejection'; readonly status: number })
  | (OpenCodeAttempt & { readonly state: 'unavailable'; readonly code: 'aborted' | 'timeout' })

interface ClaudeAttempt {
  readonly harness: 'claude'
  readonly sessionId: string
}
/** Claude has no admission acknowledgement here; written means only local socket bytes. */
export type ClaudeDeliveryResult =
  | (ClaudeAttempt & { readonly state: 'written' })
  | (ClaudeAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' })
  | (ClaudeAttempt & { readonly state: 'unavailable'; readonly code: 'aborted' | 'timeout' | 'endpoint_unavailable' })

interface PiAttempt {
  readonly harness: 'pi'
  readonly sessionId: string
  readonly inputId: string
}
/** Observation of the correlated event, not finalized append, durability, or processing. */
export type PiDeliveryResult =
  | (PiAttempt & { readonly state: 'observed'; readonly evidence: 'message_end'; readonly delivery: Delivery })
  | (PiAttempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' | 'session_replaced' | 'native_call' })
  | (PiAttempt & { readonly state: 'rejected'; readonly code: 'wrong_session' | 'invalid_request' | 'duplicate_inflight_id' })
  | (PiAttempt & { readonly state: 'unavailable'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' })

export type DeliveryResult = OpenCodeDeliveryResult | ClaudeDeliveryResult | PiDeliveryResult
