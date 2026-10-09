declare const targetBrand: unique symbol

/** In-memory handle issued by connectExisting; not a TUI-presence guarantee. */
export interface OpenCodeTarget {
  readonly harness: 'opencode'
  readonly sessionId: string
  readonly [targetBrand]: true
}

export type Delivery = 'steer' | 'queue'

export interface SendTextOptions {
  readonly delivery?: Delivery
  readonly inputId?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

interface Attempt {
  readonly harness: 'opencode'
  readonly sessionId: string
  readonly inputId: string
}

/** Acceptance is durable inbox admission only, not model consumption or display. */
export type DeliveryResult =
  | (Attempt & { readonly state: 'accepted'; readonly inboxId: string; readonly delivery: Delivery })
  | (Attempt & { readonly state: 'unknown'; readonly code: 'timeout' | 'aborted' | 'transport' | 'invalid_response' })
  | (Attempt & { readonly state: 'rejected'; readonly code: 'http_rejection'; readonly status: number })
  | (Attempt & { readonly state: 'unavailable'; readonly code: 'aborted' | 'timeout' })
