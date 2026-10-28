import os from 'node:os'
import path from 'node:path'

/** Capture the recipient's home before another process delivers. No service discovery I/O. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const userHome = env.HOME || os.homedir()
  const raw = env.CODEX_HOME || path.join(userHome, '.codex')
  const home = raw === '~' ? userHome : raw.startsWith('~/') ? path.join(userHome, raw.slice(2)) : raw
  if (!path.isAbsolute(home) || home.includes('\0')) throw new TypeError('Invalid Codex home.')
  return home
}

export function codexQueueEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return `unix://${path.join(resolveCodexHome(env), 'app-server-control', 'app-server-control.sock')}`
}
