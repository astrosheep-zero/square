import { deadline, validSignal, validTimeout } from './deadline.js'
import { isRecord } from './guards.js'
import type { CodexBoundaryStore } from './codex-boundary.js'

export { createCodexBoundaryStore } from './codex-boundary.js'
export type { CodexBoundary, CodexBoundaryStore } from './codex-boundary.js'

export interface CodexHookResponse {
  readonly hookSpecificOutput: { readonly hookEventName: 'PostToolUse'; readonly additionalContext: string }
}
export interface CodexHookOptions {
  readonly boundaries: CodexBoundaryStore
  /** The host owns pending text, claims and cancellation. Honor signal before presenting;
   * if cancelled before an effect, release custody and resolve undefined or reject.
   * After presenting, finish any cancellation-independent settlement and return its text,
   * even if signal aborts meanwhile. This callback is awaited, never raced or abandoned. */
  readonly pull?: (sessionId: string, signal: AbortSignal) => Promise<string | undefined>
  /** Dispatch the host's pending work; Stop merely makes queue eligible. */
  readonly sweep?: (cwd: string | undefined, deadline: number, signal: AbortSignal) => Promise<void>
  readonly end?: (sessionId: string, signal: AbortSignal) => Promise<void>
  readonly trace?: (stage: string, detail?: string) => void
  readonly timeoutMs?: number
  readonly sweepTimeoutMs?: number
  readonly signal?: AbortSignal
}

/** Stateless hook protocol. No message source, session identity or service is invented here. */
export async function handleCodexHook(input: unknown, options: CodexHookOptions): Promise<CodexHookResponse | undefined> {
  if (!isRecord(input) || typeof input.session_id !== 'string' || !input.session_id.trim()) return
  const event = input.hook_event_name
  if (!['SessionStart', 'SessionResume', 'UserPromptSubmit', 'SessionEnd', 'PostToolUse', 'Stop'].includes(event as string)) return
  if (!validTimeout(options.timeoutMs) || !validTimeout(options.sweepTimeoutMs) || !validSignal(options.signal)) {
    throw new TypeError('Invalid hook control.')
  }
  const scope = deadline(options.timeoutMs ?? 4500, options.signal)
  const sweepDeadline = Date.now() + Math.min(options.sweepTimeoutMs ?? 3000, options.timeoutMs ?? 4500)
  const id = input.session_id
  try {
    scope.check()
    if (event === 'SessionEnd') {
      await scope.wait(options.boundaries.record(id, 'end', scope.signal))
      await scope.wait(options.end?.(id, scope.signal) ?? Promise.resolve()).catch(() => {})
      return
    }
    await scope.wait(options.boundaries.record(id,
      event === 'SessionStart' || event === 'SessionResume' ? 'start' : event === 'Stop' ? 'Stop' : 'non-stop', scope.signal))
    options.trace?.('boundary-record')
    if (event !== 'Stop' && event !== 'PostToolUse') return
    let context: string | undefined
    if (event === 'PostToolUse') {
      try {
        // A host's successful presentation settlement may outlive this signal. Retain
        // its output instead of leaving background work to consume it without a response.
        context = await options.pull?.(id, scope.signal)
        options.trace?.('presentation')
      } catch (error) {
        options.trace?.('presentation', `error=${error instanceof Error ? error.name : 'Error'}`)
      }
    }
    if (!scope.signal.aborted && Date.now() < sweepDeadline) {
      await scope.wait(options.sweep?.(typeof input.cwd === 'string' ? input.cwd : undefined,
        sweepDeadline, scope.signal) ?? Promise.resolve()).catch(() => {})
    }
    options.trace?.('sweep', scope.signal.aborted ? 'aborted=true' : '')
    // A successful pull may already have committed host presentation evidence.
    // A later, unrelated sweep timeout must not discard its completed output.
    if (context !== undefined) {
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }
    }
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason
    throw error
  } finally { scope.close() }
}
