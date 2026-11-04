import { deadline, validSignal, validTimeout } from './deadline.js'
import { isRecord } from './guards.js'
import type { CodexBoundaryStore } from './codex-boundary.js'

export { createCodexBoundaryStore } from './codex-boundary.js'
export type { CodexBoundary, CodexBoundaryStore, CodexStopEpoch } from './codex-boundary.js'
export { codexIdleAtStop } from './codex.js'

export type CodexActiveEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'
export type CodexHookEvent = CodexActiveEvent | 'SessionStart' | 'SessionEnd' | 'Stop' | 'Interrupt'
export interface CodexHookInput { readonly session_id: string; readonly hook_event_name: CodexHookEvent; readonly turn_id?: string }
export interface CodexHookResponse {
  readonly hookSpecificOutput: { readonly hookEventName: CodexActiveEvent; readonly additionalContext: string }
}
export interface CodexHookOptions {
  readonly boundaries: CodexBoundaryStore
  /** The host owns claims and cancellation. After an external effect, finish its
   * cancellation-independent settlement and retain the output. Never abandon it. */
  readonly pull?: (sessionId: string, signal: AbortSignal, event: CodexActiveEvent) => Promise<string | undefined>
  readonly end?: (sessionId: string, signal: AbortSignal) => Promise<void>
  readonly interrupt?: (sessionId: string, signal: AbortSignal) => Promise<void>
  readonly trace?: (stage: string, detail?: string) => void
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export function parseCodexHook(input: unknown): CodexHookInput | undefined {
  const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
  if (!isRecord(input) || !identity(input.session_id) ||
    !['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Stop', 'Interrupt'].includes(input.hook_event_name as string) ||
    (['Stop', 'Interrupt'].includes(input.hook_event_name as string) && !identity(input.turn_id))) return
  return input as unknown as CodexHookInput
}

/** Native synchronous boundaries; Stop only records authority for its async receiver. */
export async function handleCodexHook(value: unknown, options: CodexHookOptions): Promise<CodexHookResponse | undefined> {
  const input = parseCodexHook(value)
  if (!input) return
  if (!validTimeout(options.timeoutMs) || !validSignal(options.signal)) throw new TypeError('Invalid hook control.')
  const scope = deadline(options.timeoutMs ?? 4500, options.signal)
  const event = input.hook_event_name, id = input.session_id
  try {
    scope.check()
    await scope.wait(options.boundaries.record(id,
      event === 'SessionStart' ? 'start' : event === 'SessionEnd' ? 'end' : event === 'Stop' ? 'Stop' : 'non-stop',
      { signal: scope.signal, turnId: input.turn_id }))
    options.trace?.('boundary-record')
    if (event === 'SessionEnd' || event === 'Interrupt') {
      await (event === 'SessionEnd' ? options.end : options.interrupt)?.(id, scope.signal)
      return
    }
    if (event !== 'UserPromptSubmit' && event !== 'PreToolUse' && event !== 'PostToolUse') return
    try {
      const context = await options.pull?.(id, scope.signal, event)
      options.trace?.('presentation')
      if (context !== undefined) return { hookSpecificOutput: { hookEventName: event, additionalContext: context } }
    } catch (error) {
      options.trace?.('presentation', `error=${error instanceof Error ? error.name : 'Error'}`)
    }
  } finally { scope.close() }
}
