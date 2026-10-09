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
export type Target = OpenCodeTarget | ClaudeTarget

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
export type SendTextOptions = OpenCodeSendTextOptions | ClaudeSendTextOptions

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

export type DeliveryResult = OpenCodeDeliveryResult | ClaudeDeliveryResult
