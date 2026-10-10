import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DeliveryError } from './errors.js'
import { parseLocalEndpoint, type LocalEndpoint } from './local-endpoint.js'

const TOKEN = /^[0-9a-f]{32}$/
const KEY = /^(\d+)\.([0-9a-f]{64})\.key$/

export interface ClaudeAuthOptions {
  readonly endpoint: LocalEndpoint | string
  readonly token?: string
  readonly claudeHome?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}

function validToken(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value) }

/**
 * Explicit token, then the environment token bound to this exact endpoint, then
 * the newest readable peer key for it. Windows requires a token; POSIX does not.
 */
export async function resolveClaudeToken(options: ClaudeAuthOptions): Promise<string | undefined> {
  const endpoint = typeof options.endpoint === 'string' ? parseLocalEndpoint(options.endpoint) : options.endpoint
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (options.token !== undefined) {
    if (!validToken(options.token)) throw new DeliveryError('authentication_failed', false)
    return options.token
  }
  if (validToken(env.CLAUDE_CODE_MESSAGING_TOKEN) && env.CLAUDE_CODE_MESSAGING_SOCKET !== undefined) {
    try {
      if (parseLocalEndpoint(env.CLAUDE_CODE_MESSAGING_SOCKET).canonical === endpoint.canonical) return env.CLAUDE_CODE_MESSAGING_TOKEN
    } catch { /* an unrelated malformed environment coordinate is ignored */ }
  }
  const home = options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const digest = createHash('sha256').update(endpoint.canonical).digest('hex')
  const keys: { name: string; pid: number; mtimeMs: number }[] = []
  try {
    for (const name of await readdir(join(home, 'sessions'))) {
      const match = KEY.exec(name)
      if (!match || match[2] !== digest) continue
      try { keys.push({ name, pid: Number(match[1]), mtimeMs: (await stat(join(home, 'sessions', name))).mtimeMs }) } catch { /* unreadable entries are skipped */ }
    }
  } catch { /* no registry is not an error; it only means no peer key */ }
  keys.sort((a, b) => Number(isAlive(b.pid)) - Number(isAlive(a.pid)) || b.mtimeMs - a.mtimeMs)
  for (const key of keys) {
    try {
      const value: unknown = JSON.parse(await readFile(join(home, 'sessions', key.name), 'utf8'))
      if (value && typeof value === 'object' && validToken((value as Record<string, unknown>).peerToken)) {
        return (value as Record<string, string>).peerToken
      }
    } catch { /* the next readable matching key wins */ }
  }
  if (platform === 'win32') throw new DeliveryError('authentication_failed', false)
  return undefined
}

/** A pid that exists, including one owned by another user, holds a live inbox. */
function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
