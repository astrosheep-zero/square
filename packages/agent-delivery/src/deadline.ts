export const DEFAULT_TIMEOUT_MS = 5_000

export function validTimeout(value: unknown): value is number | undefined {
  // Node clamps larger timers to 1ms; do not silently turn a deadline into that.
  return value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 2_147_483_647)
}

export function validSignal(value: unknown): value is AbortSignal | undefined {
  return value === undefined || value instanceof AbortSignal
}

/** Bounds caller waiting even for Service.discover, which cannot accept a signal. */
export function deadline(timeoutMs = DEFAULT_TIMEOUT_MS, parent?: AbortSignal) {
  const controller = new AbortController()
  let code: 'aborted' | 'timeout' | undefined
  let rejectStopped!: (error: Error) => void
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject })
  // A pre-aborted scope may never reach wait().
  void stopped.catch(() => {})
  const stop = (reason: 'aborted' | 'timeout') => {
    if (code !== undefined) return
    code = reason
    controller.abort()
    rejectStopped(new Error('Operation stopped.'))
  }
  const onAbort = () => stop('aborted')
  parent?.addEventListener('abort', onAbort, { once: true })
  if (parent?.aborted) onAbort()
  const timer = setTimeout(() => stop('timeout'), timeoutMs)
  return {
    signal: controller.signal,
    get code() { return code },
    check() { if (code !== undefined) throw new Error('Operation stopped.') },
    wait<T>(operation: Promise<T>): Promise<T> { return Promise.race([operation, stopped]) },
    close() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}
