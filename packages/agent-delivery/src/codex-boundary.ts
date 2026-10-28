import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { withFileLock } from './file-lock.js'

export interface CodexBoundary { readonly lastStop: number; readonly lastNonStop: number; readonly ended?: true }
export interface CodexBoundaryStore {
  read(sessionId: string): Promise<CodexBoundary | undefined>
  queueEligible(sessionId: string): Promise<boolean>
  record(sessionId: string, event: 'Stop' | 'non-stop' | 'start' | 'end', signal?: AbortSignal): Promise<void>
  clear(sessionId: string, signal?: AbortSignal): Promise<void>
}
interface BoundaryFile { v: 1; nextSequence: number; threads: Record<string, CodexBoundary> }
const empty = (): BoundaryFile => ({ v: 1, nextSequence: 0, threads: Object.create(null) })

/** Caller-owned observation file, shared by independent hook and sender processes. */
export function createCodexBoundaryStore(file: string): CodexBoundaryStore {
  const load = async (): Promise<BoundaryFile> => {
    let raw: string
    try { raw = await fs.readFile(file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error }
    try {
      const value = JSON.parse(raw)
      if (value?.v !== 1 || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0 ||
        !value.threads || typeof value.threads !== 'object') return empty()
      const result = empty()
      result.nextSequence = value.nextSequence
      for (const [id, boundary] of Object.entries(value.threads)) {
        const item = boundary as CodexBoundary | null
        if (item && Number.isSafeInteger(item.lastStop) && item.lastStop >= 0 &&
          Number.isSafeInteger(item.lastNonStop) && item.lastNonStop >= 0) result.threads[id] = item
      }
      return result
    } catch { return empty() }
  }
  const update = (change: (state: BoundaryFile) => void, signal?: AbortSignal) =>
    withFileLock(`${file}.lock`, { retryMs: 10, signal }, async () => {
      const state = await load()
      change(state)
      signal?.throwIfAborted()
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
        await fs.rename(temporary, file)
      } finally { await fs.unlink(temporary).catch(() => {}) }
    })
  const read = async (id: string) => id ? (await load()).threads[id] : undefined
  return {
    read,
    async queueEligible(id) {
      const boundary = await read(id)
      return boundary !== undefined && boundary.ended !== true && boundary.lastStop > boundary.lastNonStop
    },
    async record(id, event, signal) {
      if (!id) return
      await update((state) => {
        const previous = state.threads[id] ?? { lastStop: 0, lastNonStop: 0 }
        // A late Stop/tool callback must not reopen an ended session.
        if (previous.ended && event !== 'start') return
        state.nextSequence += 1
        state.threads[id] = event === 'start'
          ? { lastStop: 0, lastNonStop: state.nextSequence }
          : event === 'end' ? { ...previous, lastNonStop: state.nextSequence, ended: true }
            : event === 'Stop' ? { ...previous, lastStop: state.nextSequence }
              : { ...previous, lastNonStop: state.nextSequence }
      }, signal)
    },
    async clear(id, signal) { if (id) await update((state) => { delete state.threads[id] }, signal) },
  }
}
