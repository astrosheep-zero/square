export type DeliveryErrorCode =
  | 'invalid_arguments' | 'unsupported_platform' | 'unavailable' | 'authentication_failed'
  | 'session_not_found' | 'rejected' | 'unsupported_version' | 'invalid_response'
  | 'timeout' | 'aborted' | 'transport'

const messages: Record<DeliveryErrorCode, string> = {
  invalid_arguments: 'Invalid delivery arguments.',
  unsupported_platform: 'This delivery transport is not supported on this platform.',
  unavailable: 'The delivery endpoint is unavailable.',
  authentication_failed: 'Delivery authentication failed.',
  session_not_found: 'The requested session was not found.',
  rejected: 'The delivery was rejected.',
  unsupported_version: 'The receiving service version is unsupported.',
  invalid_response: 'The receiving service returned an invalid response.',
  timeout: 'The delivery deadline expired.',
  aborted: 'The delivery was aborted.',
  transport: 'The delivery transport failed.',
}

/** Diagnostics intentionally contain no endpoint, credentials, body, or SDK cause. */
export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode
  readonly maybeDelivered: boolean
  readonly id?: string
  readonly status?: number

  constructor(code: DeliveryErrorCode, maybeDelivered = false, id?: string, status?: number) {
    super(messages[code])
    this.name = 'DeliveryError'
    this.code = code
    this.maybeDelivered = maybeDelivered
    if (id !== undefined) this.id = id
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) this.status = status
  }
}

/** Internal connection precondition failure; the public entry translates it. */
export type ConnectionErrorCode = DeliveryErrorCode | 'service_unavailable' | 'http_rejection'
export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode
  readonly status?: number

  constructor(code: ConnectionErrorCode, status?: number) {
    super(messages[code as DeliveryErrorCode] ?? (code === 'http_rejection' ? 'The receiving service rejected the request.' : 'No compatible existing service is available.'))
    this.name = 'ConnectionError'
    this.code = code
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) this.status = status
  }
}
