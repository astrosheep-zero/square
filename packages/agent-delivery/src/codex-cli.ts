import { randomUUID } from 'node:crypto'
import { resolveCodexHome } from './codex-endpoint.js'
import { sendCodexQueue, CodexQueueSendError } from './codex-queue.js'
import { deadline, DEFAULT_TIMEOUT_MS, validSignal, validTimeout } from './deadline.js'
import { ConnectionError, DeliveryError } from './errors.js'
import { isIdentity, isRecord } from './guards.js'
import type { CodexCliConnectOptions, CodexSendTextOptions } from './types.js'

/** Bind once; no subprocess or lifecycle read until queue(). The receiver's
 * hooks and this client share one lifecycle source, never a Square default. */
export async function connectCodexCli(options: CodexCliConnectOptions) {
  const text = (value: unknown): value is string => isIdentity(value) && !value.includes('\0')
  if (!isRecord(options) || options.harness !== 'codex' || options.transport !== 'cli' ||
    !text(options.sessionId) || !isRecord(options.boundaries) || typeof options.boundaries.queueEligible !== 'function' ||
    !validTimeout(options.timeoutMs) || !validSignal(options.signal) ||
    (options.codexHome !== undefined && !text(options.codexHome)) ||
    (options.endpoint !== undefined && !text(options.endpoint)) || (options.bin !== undefined && !text(options.bin)) ||
    (options.args !== undefined && (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) ||
    (options.env !== undefined && (!isRecord(options.env) || Object.entries(options.env).some(([key, v]) =>
      key.includes('\0') || (v !== undefined && (typeof v !== 'string' || v.includes('\0'))))))) {
    throw new ConnectionError('invalid_arguments')
  }
  if (options.signal?.aborted) throw new ConnectionError('aborted')
  const env = { ...(options.env ?? process.env) }
  try { env.CODEX_HOME = resolveCodexHome(options.codexHome === undefined ? env : { ...env, CODEX_HOME: options.codexHome }) }
  catch { throw new ConnectionError('invalid_arguments') }
  const sessionId = options.sessionId
  const eligible = options.boundaries.queueEligible.bind(options.boundaries)
  const cli = { env, bin: options.bin, args: options.args === undefined ? undefined : [...options.args], endpoint: options.endpoint }
  return {
    coordinate: sessionId,
    async send(text: string, value: CodexSendTextOptions) {
      if (typeof text !== 'string' || !text.trim() || text.includes('\0') || !isRecord(value) ||
        value.delivery !== 'queue' || value.inputId !== undefined || !validTimeout(value.timeoutMs) || !validSignal(value.signal)) {
        throw new TypeError('Invalid Codex queue arguments.')
      }
      const inputId = randomUUID() // Local attempt correlation; the CLI does not accept a client message id.
      const scope = deadline(value.timeoutMs, value.signal)
      const until = Date.now() + (value.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      let launched = false
      try {
        scope.check()
        // One check, immediately before launching the CLI. SessionEnd/late Stop
        // suppression belongs to the bound source, not every sending caller.
        if (!await scope.wait(eligible(sessionId))) throw new DeliveryError('session_inactive', false, inputId)
        scope.check()
        const remaining = until - Date.now()
        if (remaining <= 0) throw new DeliveryError('timeout', false, inputId)
        launched = true
        await sendCodexQueue({ threadId: sessionId, message: text }, { ...cli, timeoutMs: remaining, signal: scope.signal })
        return { state: 'admitted', inputId }
      } catch (error) {
        if (error instanceof DeliveryError) throw error
        if (error instanceof CodexQueueSendError) throw new DeliveryError(scope.code ?? error.code, error.maybeDelivered, inputId)
        throw new DeliveryError(scope.code ?? (launched ? 'transport' : 'unavailable'), launched, inputId)
      } finally { scope.close() }
    },
  }
}
