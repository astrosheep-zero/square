import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep local fixture requests off environment proxies, which may themselves retry POSTs.
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',')
process.env.no_proxy = process.env.NO_PROXY

// Also imported by each test: direct node --test invocation cannot discover real services.
export const sandbox = mkdtempSync(join(tmpdir(), 'agent-delivery-test-'))
for (const [name, dir] of Object.entries({
  HOME: 'home', XDG_STATE_HOME: 'state', XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache',
})) {
  process.env[name] = join(sandbox, dir)
  mkdirSync(process.env[name], { recursive: true })
}
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))
