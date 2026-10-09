export type ConnectionErrorCode =
  | 'invalid_arguments'
  | 'aborted'
  | 'timeout'
  | 'service_unavailable'
  | 'unsupported_version'
  | 'unsupported_platform'
  | 'authentication_failed'
  | 'session_not_found'
  | 'http_rejection'
  | 'invalid_response'

const messages: Record<ConnectionErrorCode, string> = {
  invalid_arguments: 'Invalid connection arguments.',
  aborted: 'Connection was aborted.',
  timeout: 'Connection deadline expired.',
  service_unavailable: 'No compatible existing service is available.',
  unsupported_version: 'The existing service is not OpenCode 2.x.',
  unsupported_platform: 'Claude native inbox support is validated only on macOS.',
  authentication_failed: 'The existing service refused authentication.',
  session_not_found: 'The existing service has no such session.',
  http_rejection: 'The existing service rejected the connection request.',
  invalid_response: 'The existing service returned an invalid response.',
}

/** Diagnostics intentionally contain no endpoint, credentials, body, or SDK cause. */
export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode
  readonly status?: number

  constructor(code: ConnectionErrorCode, status?: number) {
    super(messages[code])
    this.name = 'ConnectionError'
    this.code = code
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
      this.status = status
    }
  }
}
