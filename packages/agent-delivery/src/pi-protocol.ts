import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'

export const VERSION = 'agent-delivery/pi/1'
export const MAX_FRAME_BYTES = 256 * 1024
export const MAX_TEXT_BYTES = 128 * 1024
export const MAX_WAIT_MS = 30_000
export const FRAME_WAIT_MS = 5_000
export const MAX_CONNECTIONS = 64
export const CUSTOM_TYPE = 'agent-delivery'

export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256
export const endpointValid = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && Buffer.byteLength(value) <= 103
export const waitValid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_WAIT_MS

/** One bounded UTF-8 JSON object terminated only by LF, never Unicode separators. */
export function readFrame(socket: Socket, receive: (value: unknown) => void, invalid: () => void): () => void {
  let chunks: Buffer[] = []
  let size = 0
  const onData = (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_FRAME_BYTES) { stop(); invalid(); return }
    const newline = chunk.indexOf(10)
    chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline))
    if (newline < 0) return
    stop()
    try {
      if (newline !== chunk.length - 1) throw new Error()
      const bytes = Buffer.concat(chunks)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      receive(JSON.parse(text))
    } catch { invalid() }
    chunks = []
  }
  const stop = () => socket.off('data', onData)
  socket.on('data', onData)
  return stop
}

export function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > MAX_FRAME_BYTES) throw new TypeError('Pi request is too large.')
  return bytes
}
