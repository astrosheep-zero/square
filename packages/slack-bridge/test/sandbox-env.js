import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No test may inherit a live harness session, the real Square ledger or a real
// Paseo daemon. Direct `node --test` also gets isolation through this import.
export const sandbox = mkdtempSync(join(tmpdir(), 'square-slack-bridge-test-'))
for (const [name, directory] of Object.entries({
  HOME: 'home',
  XDG_CONFIG_HOME: 'config',
  XDG_STATE_HOME: 'state',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
  SQUARE_HOST_LEDGER_ROOT: 'ledger',
  PASEO_HOME: 'paseo',
})) {
  process.env[name] = join(sandbox, directory)
  mkdirSync(process.env[name], { recursive: true })
}
process.env.PASEO_HOST = `unix://${join(sandbox, 'paseo', 'daemon.sock')}`
process.env.SQUARE_REGISTRY = join(sandbox, 'sessions.ndjsonl')
for (const name of ['PASEO_PASSWORD', 'PI_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID', 'PASEO_AGENT_ID', 'SQUARE_LOCATION', 'SQUARE_PARTICIPANT_NAME']) delete process.env[name]

process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))
