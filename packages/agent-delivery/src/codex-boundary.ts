import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { withFileLock } from './file-lock.js'

export interface CodexStopEpoch { readonly token: string; readonly turnId: string }
export interface CodexBoundary { readonly stop?: CodexStopEpoch; readonly ended?: true }
export interface CodexBoundaryStore {
  read(sessionId: string): Promise<CodexBoundary | undefined>
  queueEligible(sessionId: string, epoch?: CodexStopEpoch): Promise<boolean>
  record(sessionId: string, event: 'Stop' | 'non-stop' | 'start' | 'end', options?: { readonly signal?: AbortSignal; readonly turnId?: string }): Promise<void>
}
interface BoundaryFile { v: 2; threads: Record<string, CodexBoundary> }
const empty = (): BoundaryFile => ({ v: 2, threads: Object.create(null) })
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')

/** Receiver-owned idle authority. Old or unverifiable records never arm a send. */
export function createCodexBoundaryStore(file: string): CodexBoundaryStore {
  const load = async (): Promise<BoundaryFile> => {
    let raw: string
    try { raw = await fs.readFile(file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error }
    try {
      const value = JSON.parse(raw)
      if (value?.v !== 2 || !value.threads || typeof value.threads !== 'object' || Array.isArray(value.threads)) return empty()
      const result = empty()
      for (const [id, item] of Object.entries(value.threads) as [string, CodexBoundary | null][]) {
        if (!item || typeof item !== 'object') continue
        result.threads[id] = item.ended === true ? { ended: true }
          : identity(item.stop?.token) && identity(item.stop?.turnId) ? { stop: { token: item.stop.token, turnId: item.stop.turnId } } : {}
      }
      return result
    } catch { return empty() }
  }
  const read = async (id: string) => id ? (await load()).threads[id] : undefined
  return {
    read,
    async queueEligible(id, epoch) {
      const boundary = await read(id)
      return boundary?.ended !== true && boundary?.stop !== undefined &&
        (epoch === undefined || boundary.stop.token === epoch.token && boundary.stop.turnId === epoch.turnId)
    },
    async record(id, event, options = {}) {
      if (!identity(id)) return
      await withFileLock(`${file}.lock`, { retryMs: 10, signal: options.signal }, async () => {
        const state = await load()
        // A late callback cannot reopen an ended native session.
        if (state.threads[id]?.ended && event !== 'start') return
        state.threads[id] = event === 'end' ? { ended: true }
          : event === 'Stop' && identity(options.turnId) ? { stop: { token: randomUUID(), turnId: options.turnId } } : {}
        options.signal?.throwIfAborted()
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
          options.signal?.throwIfAborted()
          await fs.rename(temporary, file)
        } finally { await fs.unlink(temporary).catch(() => {}) }
      })
    },
  }
}
