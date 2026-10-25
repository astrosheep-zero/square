import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { caseDir } from './fixtures.js'

const exec = promisify(execFile)
const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist/cli.js')

async function run(args) {
  try {
    return { code: 0, ...(await exec(process.execPath, [cli, ...args], { timeout: 30_000 })) }
  }
  catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function config(body) {
  const root = await caseDir('cli')
  const file = join(root, 'bridge.json')
  await writeFile(file, JSON.stringify(body))
  return { root, file }
}

const valid = {
  square: 'team.square',
  channel: 'C0123456789',
  bridge: { appTokenEnv: 'SLACK_BRIDGE_APP_TOKEN', botTokenEnv: 'SLACK_BRIDGE_BOT_TOKEN' },
}

test('the bin refuses without a config and explains itself', async () => {
  const missing = await run([])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /--config is required/)

  const help = await run(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /usage: square-slack-bridge --config <file>/)

  const unknown = await run(['--port', '1'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /unknown argument --port/)
})

test('the bin exits nonzero with a clear message and no token value', async () => {
  const absent = await run(['--config', '/nonexistent/bridge.json'])
  assert.equal(absent.code, 1)
  assert.match(absent.stderr, /cannot read config file/)

  const { root, file } = await config(valid)
  const noSquare = await run(['--config', file])
  assert.equal(noSquare.code, 1)
  assert.match(noSquare.stderr, /square does not exist/)

  await writeFile(join(root, 'team.square'), '')
  const noSecrets = await run(['--config', file])
  assert.equal(noSecrets.code, 1)
  assert.match(noSecrets.stderr, /SLACK_BRIDGE_APP_TOKEN/)
  assert.doesNotMatch(noSecrets.stderr, /xoxb|xapp/)
})
