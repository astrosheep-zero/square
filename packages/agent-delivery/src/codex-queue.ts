import { execFile } from 'node:child_process'
export { codexQueueEndpoint } from './codex-endpoint.js'
import { validSignal, validTimeout } from './deadline.js'
import type { DeliveryErrorCode } from './errors.js'

export interface CodexQueueRequest { readonly threadId: string; readonly message: string }
export interface CodexQueueOptions {
  readonly bin?: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly endpoint?: string
}
export type CodexQueueFailureKind = 'transient' | 'rejected' | 'unknown'

/** Once the child starts, a timeout or unexplained exit does not establish non-delivery. */
export class CodexQueueSendError extends Error {
  constructor(readonly kind: CodexQueueFailureKind, readonly code: DeliveryErrorCode) {
    super(kind === 'unknown' ? 'Codex queue outcome is unknown.' : 'Codex queue is unavailable or rejected the request.')
    this.name = 'CodexQueueSendError'
  }
  get maybeDelivered() { return this.kind === 'unknown' }
}

/** Internal CLI transport. Lifecycle checking belongs to the bound CLI client. */
export async function sendCodexQueue(request: CodexQueueRequest, options: CodexQueueOptions = {}): Promise<void> {
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
  if (!request || !text(request.threadId) || !text(request.message) || !validTimeout(options.timeoutMs) || !validSignal(options.signal) ||
    (options.bin !== undefined && !text(options.bin)) ||
    (options.args !== undefined && (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) ||
    (options.endpoint !== undefined && !text(options.endpoint))) throw new TypeError('Invalid Codex queue arguments.')
  if (options.signal?.aborted) throw new CodexQueueSendError('transient', 'aborted')
  await new Promise<void>((resolve, reject) => {
    execFile(options.bin ?? 'codex',
      [...(options.args ?? []), 'queue', ...(options.endpoint === undefined ? [] : ['--remote', options.endpoint]),
        '--thread', request.threadId, '--message', request.message],
      { encoding: 'utf8', env: options.env ?? process.env, timeout: options.timeoutMs ?? 5000,
        signal: options.signal, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (!error) { resolve(); return }
        const code = error.code as string | number | undefined
        const output = `${stderr}${stdout}`
        if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC') {
          reject(new CodexQueueSendError('transient', 'unavailable'))
        } else if (code === 'ABORT_ERR') {
          reject(new CodexQueueSendError('unknown', 'aborted'))
        } else if (error.killed && code == null) {
          reject(new CodexQueueSendError('unknown', 'timeout'))
        } else if (/^Error: failed to connect (?:to socket|to remote app server)|^Error: failed to upgrade /m.test(output)) {
          reject(new CodexQueueSendError('transient', 'unavailable'))
        } else if (/does not support thread\/queue\/add|unrecognized subcommand/.test(output)) {
          reject(new CodexQueueSendError('rejected', 'unsupported_version'))
        } else if (/unknown thread|thread not found:|session .*not found|No active session|invalid thread id|ephemeral thread does not support queued submissions|unexpected argument/.test(output)) {
          reject(new CodexQueueSendError('rejected', 'rejected'))
        } else reject(new CodexQueueSendError('unknown', 'transport'))
      })
  })
}
